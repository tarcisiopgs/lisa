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
			const result = await execa(
				"opencode",
				["run", prompt],
				{
					cwd: opts.cwd,
					timeout: 30 * 60 * 1000,
					reject: false,
				},
			);

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
