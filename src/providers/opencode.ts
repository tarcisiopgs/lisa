import { execa } from "execa";
import type { Effort, Provider, RunOptions, RunResult } from "../types.js";

const MODEL_MAP: Record<Effort, string> = {
	low: "anthropic/claude-haiku",
	medium: "anthropic/claude-sonnet",
	high: "anthropic/claude-opus",
};

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
		const model = opts.model || MODEL_MAP[opts.effort];
		const start = Date.now();

		try {
			const result = await execa(
				"opencode",
				["run", "-m", model, prompt],
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
