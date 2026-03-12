import { execSync, spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as logger from "../output/logger.js";
import { getOutputMode } from "../output/logger.js";
import {
	createErrorLoopDetector,
	createOutputStallDetector,
	STALL_MESSAGE,
	STUCK_MESSAGE,
	startOverseer,
} from "../session/overseer.js";
import type { Provider, RunOptions, RunResult } from "../types/index.js";
import { kanbanEmitter } from "../ui/state.js";
import { buildNodeOptions } from "./heap.js";
import { OutputBuffer } from "./output-buffer.js";
import { spawnWithPty, stripAnsi } from "./pty.js";
import { createSessionTimeout, TIMEOUT_MESSAGE } from "./timeout.js";

export class ClaudeProvider implements Provider {
	name = "claude" as const;
	supportsNativeWorktree = false; // --worktree flag requires a TTY and hangs in non-interactive mode

	async isAvailable(): Promise<boolean> {
		try {
			execSync("claude --version", { stdio: "ignore" });
			return true;
		} catch {
			return false;
		}
	}

	async run(prompt: string, opts: RunOptions): Promise<RunResult> {
		const start = Date.now();

		// Write prompt to temp file (avoids arg length limits, matches Ralph's pattern)
		const tmpDir = mkdtempSync(join(tmpdir(), "lisa-"));
		const promptFile = join(tmpDir, "prompt.md");
		writeFileSync(promptFile, prompt, "utf-8");

		try {
			const flags = ["-p", "--dangerously-skip-permissions"];
			if (opts.model) {
				flags.push("--model", opts.model);
			}
			if (opts.providerOptions?.effort) {
				flags.push("--effort", opts.providerOptions.effort);
			}

			const command = `claude ${flags.join(" ")} "$(cat '${promptFile}')"`;
			logger.log(`[claude] Running: claude ${flags.join(" ")}`.trim());
			if (opts.issueId) {
				kanbanEmitter.emit(
					"issue:output",
					opts.issueId,
					`$ claude ${flags.join(" ")} <prompt: ${prompt.length} chars>\n`,
				);
			}
			const spawnEnv = {
				...process.env,
				...opts.env,
				CLAUDECODE: undefined,
				NODE_OPTIONS: buildNodeOptions(),
			};
			// When Lisa itself runs inside an active Claude Code session (CLAUDECODE is set in the
			// parent environment), the script PTY wrapper reads EOF from its closed stdin and
			// forwards ^D to Claude, causing it to exit. Use a plain spawn without PTY instead.
			const isNestedInClaude = Boolean(process.env.CLAUDECODE);
			let proc: ReturnType<typeof spawn>;
			let isPty: boolean;
			if (isNestedInClaude) {
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
			const errorLoopDetector = createErrorLoopDetector(proc, /^Error /);
			const outputStall = createOutputStallDetector(proc, opts.outputStallTimeout);

			const chunks = new OutputBuffer();
			const stderrChunks = new OutputBuffer();

			proc.stdout?.on("data", (chunk: Buffer) => {
				const raw = chunk.toString();
				const text = isPty ? stripAnsi(raw) : raw;
				errorLoopDetector.check(text);
				outputStall.reset();
				if (getOutputMode() !== "tui") process.stdout.write(raw);
				if (opts.issueId) {
					kanbanEmitter.emit("issue:output", opts.issueId, raw);
				}
				chunks.push(text);
				try {
					appendFileSync(opts.logFile, text);
				} catch {}
			});

			proc.stderr?.on("data", (chunk: Buffer) => {
				const raw = chunk.toString();
				const text = isPty ? stripAnsi(raw) : raw;
				if (getOutputMode() !== "tui") process.stderr.write(raw);
				stderrChunks.push(text);
				try {
					appendFileSync(opts.logFile, text);
				} catch {}
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
				output: err instanceof Error ? err.message : String(err),
				duration: Date.now() - start,
			};
		} finally {
			try {
				rmSync(tmpDir, { recursive: true, force: true });
			} catch {}
		}
	}
}
