import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { escapeShellPath, OutputBuffer, safeAppendLog } from "./output-buffer.js";
import { spawnWithPty, stripAnsi } from "./pty.js";
import { createSessionTimeout, TIMEOUT_MESSAGE } from "./timeout.js";

export class CopilotProvider implements Provider {
	name = "copilot" as const;

	async isAvailable(): Promise<boolean> {
		try {
			execSync("copilot version", { stdio: "ignore" });
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
			// --allow-all: bypass all tool/path/url permission prompts (non-interactive)
			// -p: run prompt and exit (print mode)
			const modelFlag = opts.model ? `--model ${opts.model}` : "";
			const command = `copilot --allow-all ${modelFlag} -p "$(cat '${escapeShellPath(promptFile)}')"`;
			logger.log(
				`[copilot] Running: copilot --allow-all ${modelFlag || "(default model)"} -p`.trim(),
			);
			if (opts.issueId) {
				kanbanEmitter.emit(
					"issue:output",
					opts.issueId,
					`$ copilot --allow-all ${modelFlag || "(default model)"} -p <prompt: ${prompt.length} chars>\n`,
				);
			}
			const { proc, isPty } = spawnWithPty(command, {
				cwd: opts.cwd,
				env: { ...process.env, ...opts.env, NODE_OPTIONS: buildNodeOptions() },
			});

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
