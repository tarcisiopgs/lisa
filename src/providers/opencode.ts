import { spawn, execSync } from "node:child_process";
import { appendFileSync, writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Provider, RunOptions, RunResult } from "../types.js";

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
			const proc = spawn(
				"sh",
				["-c", `opencode run "$(cat '${promptFile}')"`],
				{
					cwd: opts.cwd,
					stdio: ["ignore", "pipe", "pipe"],
				},
			);

			const chunks: string[] = [];

			proc.stdout.on("data", (chunk: Buffer) => {
				const text = chunk.toString();
				process.stdout.write(text);
				chunks.push(text);
				try { appendFileSync(opts.logFile, text); } catch {}
			});

			proc.stderr.on("data", (chunk: Buffer) => {
				const text = chunk.toString();
				process.stderr.write(text);
				try { appendFileSync(opts.logFile, text); } catch {}
			});

			const exitCode = await new Promise<number>((resolve) => {
				proc.on("close", (code) => resolve(code ?? 1));
			});

			return {
				success: exitCode === 0,
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
			try { unlinkSync(promptFile); } catch {}
		}
	}
}
