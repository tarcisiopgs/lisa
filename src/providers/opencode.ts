import { appendFileSync } from "node:fs";
import { execa } from "execa";
import type { Provider, RunOptions, RunResult } from "../types.js";

export class OpenCodeProvider implements Provider {
	name = "opencode" as const;

	async isAvailable(): Promise<boolean> {
		try {
			await execa("opencode", ["--version"]);
			return true;
		} catch {
			return false;
		}
	}

	async run(prompt: string, opts: RunOptions): Promise<RunResult> {
		const start = Date.now();

		try {
			const proc = execa(
				"opencode",
				["run", prompt],
				{
					cwd: opts.cwd,
					timeout: 30 * 60 * 1000,
					reject: false,
				},
			);

			const chunks: string[] = [];

			proc.stdout?.on("data", (chunk: Buffer) => {
				const text = chunk.toString();
				process.stdout.write(text);
				chunks.push(text);
				try { appendFileSync(opts.logFile, text); } catch {}
			});

			proc.stderr?.on("data", (chunk: Buffer) => {
				const text = chunk.toString();
				process.stderr.write(text);
				try { appendFileSync(opts.logFile, text); } catch {}
			});

			const result = await proc;

			return {
				success: result.exitCode === 0,
				output: chunks.join(""),
				duration: Date.now() - start,
			};
		} catch (err) {
			return {
				success: false,
				output: err instanceof Error ? err.message : String(err),
				duration: Date.now() - start,
			};
		}
	}
}
