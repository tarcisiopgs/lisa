import { execSync } from "node:child_process";
import { appendFileSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOutputMode } from "../output/logger.js";
import { STUCK_MESSAGE, startOverseer } from "../session/overseer.js";
import type { Provider, RunOptions, RunResult } from "../types/index.js";
import { kanbanEmitter } from "../ui/state.js";
import { spawnWithPty, stripAnsi } from "./pty.js";

export class GooseProvider implements Provider {
	name = "goose" as const;

	async isAvailable(): Promise<boolean> {
		try {
			execSync("goose --version", { stdio: "ignore" });
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
			const command = `goose run ${modelFlag} --text "$(cat '${promptFile}')"`;
			const { proc, isPty } = spawnWithPty(command, { cwd: opts.cwd });

			if (proc.pid) opts.onProcess?.(proc.pid);
			const overseer = opts.overseer?.enabled ? startOverseer(proc, opts.cwd, opts.overseer) : null;

			const chunks: string[] = [];

			proc.stdout?.on("data", (chunk: Buffer) => {
				const raw = chunk.toString();
				const text = isPty ? stripAnsi(raw) : raw;
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
				try {
					appendFileSync(opts.logFile, text);
				} catch {}
			});

			const exitCode = await new Promise<number>((resolve) => {
				proc.on("close", (code) => {
					overseer?.stop();
					resolve(code ?? 1);
				});
			});

			if (overseer?.wasKilled()) {
				chunks.push(STUCK_MESSAGE);
			}

			return {
				success: exitCode === 0 && !overseer?.wasKilled(),
				output: chunks.join(""),
				duration: Date.now() - start,
			};
		} catch (err) {
			return {
				success: false,
				output: err instanceof Error ? err.message : String(err),
				duration: Date.now() - start,
			};
		} finally {
			try {
				unlinkSync(promptFile);
			} catch {}
		}
	}
}
