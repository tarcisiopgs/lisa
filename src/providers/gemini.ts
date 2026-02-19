import { execa } from "execa";
import type { Effort, Provider, RunOptions, RunResult } from "../types.js";

const MODEL_MAP: Record<Effort, string> = {
	low: "gemini-2.5-flash",
	medium: "gemini-2.5-pro",
	high: "gemini-2.5-pro",
};

export class GeminiProvider implements Provider {
	name = "gemini" as const;

	async isAvailable(): Promise<boolean> {
		try {
			await execa("gemini", ["--version"]);
			return true;
		} catch {
			return false;
		}
	}

	async run(prompt: string, opts: RunOptions): Promise<RunResult> {
		const model = opts.model || MODEL_MAP[opts.effort];
		const start = Date.now();

		try {
			const result = await execa(
				"gemini",
				["--yolo", "-p", prompt, "-m", model],
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
