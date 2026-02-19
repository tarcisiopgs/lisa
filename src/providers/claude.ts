import { execa } from "execa";
import type { Provider, RunOptions, RunResult } from "../types.js";

export class ClaudeProvider implements Provider {
	name = "claude" as const;

	async isAvailable(): Promise<boolean> {
		try {
			await execa("claude", ["--version"]);
			return true;
		} catch {
			return false;
		}
	}

	async run(prompt: string, opts: RunOptions): Promise<RunResult> {
		const start = Date.now();

		try {
			const proc = execa(
				"claude",
				["--dangerously-skip-permissions", "-p", prompt, "--output-format", "text"],
				{
					cwd: opts.cwd,
					timeout: 30 * 60 * 1000,
					reject: false,
				},
			);

			proc.stdout?.pipe(process.stdout);
			proc.stderr?.pipe(process.stderr);

			const result = await proc;
			const output = result.stdout + (result.stderr ? `\n${result.stderr}` : "");

			return {
				success: result.exitCode === 0,
				output,
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
