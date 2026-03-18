import { execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import * as logger from "../output/logger.js";
import { getOutputMode } from "../output/logger.js";
import {
	createErrorLoopDetector,
	createOutputStallDetector,
	STALL_MESSAGE,
	STUCK_MESSAGE,
	startOverseer,
} from "../session/overseer.js";
import type { RunOptions, RunResult } from "../types/index.js";
import { kanbanEmitter } from "../ui/state.js";
import { buildNodeOptions } from "./heap.js";
import { escapeShellPath, OutputBuffer, safeAppendLog } from "./output-buffer.js";
import { spawnWithPty, stripAnsi } from "./pty.js";
import { createSessionTimeout, TIMEOUT_MESSAGE } from "./timeout.js";

/**
 * Validates a value for safe interpolation into shell command strings.
 * Allows only alphanumeric characters, dots, colons, slashes, hyphens, and underscores.
 * Rejects values containing shell metacharacters that could lead to command injection.
 */
const SAFE_SHELL_ARG = /^[a-zA-Z0-9._:/@-]+$/;

export function validateShellArg(value: string, label: string): void {
	if (!SAFE_SHELL_ARG.test(value)) {
		throw new Error(
			`Invalid ${label}: "${value}" contains unsafe characters. Only alphanumeric, dots, colons, slashes, hyphens, and underscores are allowed.`,
		);
	}
}

export function formatError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

const execFileAsync = promisify(execFile);

/**
 * Cached, async check for whether a CLI command is available.
 * Results are cached per command for the process lifetime since
 * provider availability does not change mid-run.
 */
const availabilityCache = new Map<string, boolean>();

export async function isCommandAvailable(
	command: string,
	args: string[] = ["--version"],
): Promise<boolean> {
	const key = `${command}:${args.join(",")}`;
	const cached = availabilityCache.get(key);
	if (cached !== undefined) return cached;

	try {
		await execFileAsync(command, args, { stdio: "ignore" } as never);
		availabilityCache.set(key, true);
		return true;
	} catch {
		availabilityCache.set(key, false);
		return false;
	}
}

/** @internal Exposed for testing only — resets the availability cache. */
export function resetAvailabilityCache(): void {
	availabilityCache.clear();
}

export interface ProviderProcessConfig {
	/** Provider display name (used in logs) */
	name: string;
	/**
	 * Build the shell command given the escaped prompt file path.
	 * Receives the path already formatted as `$(cat '...escaped...')` expression.
	 */
	buildCommand: (promptCatExpr: string) => string;
	/** Log line for console output (without prompt content) */
	logLine: string;
	/** Kanban event line (includes prompt length) */
	kanbanLine: string;
	/** Regex pattern for error loop detection */
	errorPattern: RegExp;
	/** Extra environment variables to merge */
	extraEnv?: Record<string, string | undefined>;
	/**
	 * When true, uses plain `spawn("sh", ...)` instead of PTY wrapper.
	 * Used when Lisa runs inside an active Claude Code session.
	 */
	forceRawSpawn?: boolean;
	/**
	 * Transform raw stdout chunks into human-readable output.
	 * Used by providers that emit structured formats (e.g., NDJSON)
	 * to convert them into readable lines for logs and TUI display.
	 */
	outputTransform?: (raw: string) => string;
}

/**
 * Shared provider process execution. Handles:
 * - Temp file creation (with restrictive permissions)
 * - Process spawning (PTY or raw)
 * - Overseer, timeout, stall, and error loop detection
 * - stdout/stderr collection and log writing
 * - Success evaluation and cleanup
 */
export async function runProviderProcess(
	config: ProviderProcessConfig,
	prompt: string,
	opts: RunOptions,
): Promise<RunResult> {
	const start = Date.now();

	const tmpDir = mkdtempSync(join(tmpdir(), "lisa-"));
	const promptFile = join(tmpDir, "prompt.md");
	writeFileSync(promptFile, prompt, { encoding: "utf-8", mode: 0o600 });

	try {
		const promptCatExpr = `"$(cat '${escapeShellPath(promptFile)}')"`;
		const command = config.buildCommand(promptCatExpr);

		logger.log(`[${config.name}] Running: ${config.logLine}`.trim());
		if (opts.issueId) {
			kanbanEmitter.emit("issue:output", opts.issueId, config.kanbanLine);
		}

		const spawnEnv = {
			...process.env,
			...opts.env,
			NODE_OPTIONS: buildNodeOptions(),
			...config.extraEnv,
		};

		let proc: ReturnType<typeof spawn>;
		let isPty: boolean;

		if (config.forceRawSpawn) {
			proc = spawn("sh", ["-c", command], {
				cwd: opts.cwd,
				env: spawnEnv,
				stdio: ["ignore", "pipe", "pipe"],
			});
			isPty = false;
		} else {
			({ proc, isPty } = spawnWithPty(command, { cwd: opts.cwd, env: spawnEnv }));
		}

		if (proc.pid) opts.onProcess?.(proc.pid);
		const overseer = opts.overseer?.enabled ? startOverseer(proc, opts.cwd, opts.overseer) : null;
		const sessionTimeout = createSessionTimeout(proc, opts.sessionTimeout);
		const errorLoopDetector = createErrorLoopDetector(proc, config.errorPattern);
		const outputStall = createOutputStallDetector(proc, opts.outputStallTimeout);

		const chunks = new OutputBuffer();
		const stderrChunks = new OutputBuffer();

		proc.stdout?.on("data", (chunk: Buffer) => {
			const raw = chunk.toString();
			const cleaned = isPty ? stripAnsi(raw) : raw;
			const text = config.outputTransform ? config.outputTransform(cleaned) : cleaned;
			if (!text) return;
			errorLoopDetector.check(text);
			outputStall.reset();
			if (getOutputMode() !== "tui") process.stdout.write(text);
			if (opts.issueId) {
				kanbanEmitter.emit("issue:output", opts.issueId, text);
			}
			chunks.push(text);
			safeAppendLog(opts.logFile, text);
		});

		proc.stderr?.on("data", (chunk: Buffer) => {
			const raw = chunk.toString();
			const text = isPty ? stripAnsi(raw) : raw;
			if (getOutputMode() !== "tui") process.stderr.write(raw);
			stderrChunks.push(text);
			safeAppendLog(opts.logFile, text);
		});

		const exitCode = await new Promise<number>((resolve) => {
			proc.on("close", (code) => {
				overseer?.stop();
				sessionTimeout.stop();
				outputStall.stop();
				resolve(code ?? 1);
			});
		});

		if (sessionTimeout.wasTimedOut()) {
			chunks.push(TIMEOUT_MESSAGE);
		} else if (outputStall.wasKilled()) {
			chunks.push(STALL_MESSAGE);
		} else if (overseer?.wasKilled() || errorLoopDetector.wasKilled()) {
			chunks.push(STUCK_MESSAGE);
		}

		const success =
			exitCode === 0 &&
			!overseer?.wasKilled() &&
			!errorLoopDetector.wasKilled() &&
			!outputStall.wasKilled() &&
			!sessionTimeout.wasTimedOut();
		const stderrOutput = stderrChunks.toString();
		if (!success && stderrOutput) {
			chunks.push(`\n[stderr]\n${stderrOutput}`);
		}

		return {
			success,
			output: chunks.toString(),
			duration: Date.now() - start,
			exitCode,
		};
	} catch (err) {
		return {
			success: false,
			output: formatError(err),
			duration: Date.now() - start,
		};
	} finally {
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {}
	}
}
