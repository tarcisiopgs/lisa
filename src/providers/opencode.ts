import { execSync, spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOutputMode } from "../output/logger.js";
import { STUCK_MESSAGE, startOverseer } from "../session/overseer.js";
import type { Provider, RunOptions, RunResult } from "../types/index.js";

export class OpenCodeProvider implements Provider {
	name = "opencode" as const;

	async isAvailable(): Promise<boolean> {
		try {
			execSync("opencode --version", { stdio: "ignore" });
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
			const proc = spawn("sh", ["-c", `opencode run "$(cat '${promptFile}')"`], {
				cwd: opts.cwd,
				stdio: ["ignore", "pipe", "pipe"],
			});

			const overseer = opts.overseer?.enabled ? startOverseer(proc, opts.cwd, opts.overseer) : null;

			const chunks: string[] = [];

			proc.stdout.on("data", (chunk: Buffer) => {
				const text = chunk.toString();
				if (getOutputMode() !== "tui") process.stdout.write(text);
				chunks.push(text);
				try {
					appendFileSync(opts.logFile, text);
				} catch {}
			});

			proc.stderr.on("data", (chunk: Buffer) => {
				const text = chunk.toString();
				if (getOutputMode() !== "tui") process.stderr.write(text);
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
