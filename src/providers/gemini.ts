import { execSync } from "node:child_process";
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
import { spawnWithPty, stripAnsi } from "./pty.js";
import { createSessionTimeout, TIMEOUT_MESSAGE } from "./timeout.js";

// Gemini-specific: these prefixes appear on every failed tool call and API error
const GEMINI_ERROR_PATTERN = /^Error (executing tool|generating content)/;

export class GeminiProvider implements Provider {
	name = "gemini" as const;

	async isAvailable(): Promise<boolean> {
		try {
			execSync("gemini --version", { stdio: "ignore" });
			return true;
		} catch {
			return false;
		}
	}

	async run(prompt: string, opts: RunOptions): Promise<RunResult> {
		const start = Date.now();

		const tmpDir = mkdtempSync(join(tmpdir(), "lisa-"));
		const promptFile = join(tmpDir, "prompt.md");
		writeFileSync(promptFile, prompt, "utf-8");

		try {
			const modelFlag = opts.model ? `--model ${opts.model}` : "";
			const command = `gemini --yolo ${modelFlag} -p "$(cat '${promptFile}')"`;
			logger.log(`[gemini] Running: gemini --yolo ${modelFlag || "(default model)"} -p`.trim());
			if (opts.issueId) {
				kanbanEmitter.emit(
					"issue:output",
					opts.issueId,
					`$ gemini --yolo ${modelFlag || "(default model)"} -p <prompt: ${prompt.length} chars>\n`,
				);
			}
			const { proc, isPty } = spawnWithPty(command, {
				cwd: opts.cwd,
				env: { ...process.env, ...opts.env },
			});

			if (proc.pid) opts.onProcess?.(proc.pid);
			const overseer = opts.overseer?.enabled ? startOverseer(proc, opts.cwd, opts.overseer) : null;
			const sessionTimeout = createSessionTimeout(proc, opts.sessionTimeout);
			const errorLoopDetector = createErrorLoopDetector(proc, GEMINI_ERROR_PATTERN);
			const outputStall = createOutputStallDetector(proc, opts.outputStallTimeout);

			const chunks: string[] = [];
			const stderrChunks: string[] = [];

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

			// Include stderr in output when the process failed so that crash
			// messages (OOM, segfault, etc.) are visible to fallback classification
			const success =
				exitCode === 0 &&
				!overseer?.wasKilled() &&
				!errorLoopDetector.wasKilled() &&
				!outputStall.wasKilled() &&
				!sessionTimeout.wasTimedOut();
			if (!success && stderrChunks.length > 0) {
				chunks.push("\n[stderr]\n", ...stderrChunks);
			}

			return {
				success,
				output: chunks.join(""),
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
