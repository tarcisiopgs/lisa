import { execa } from "execa";
import * as logger from "../logger.js";
import type { Effort, MatutoConfig, Provider, RunOptions, RunResult, Source } from "../types.js";

const MODEL_MAP: Record<Effort, string> = {
	low: "haiku",
	medium: "sonnet",
	high: "opus",
};

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
		const model = opts.model || MODEL_MAP[opts.effort];
		const start = Date.now();

		try {
			const result = await execa(
				"claude",
				["--dangerously-skip-permissions", "-p", prompt, "--model", model, "--output-format", "text"],
				{
					cwd: opts.cwd,
					timeout: 30 * 60 * 1000, // 30 min
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

	async pickIssue(source: Source, config: MatutoConfig): Promise<string | null> {
		const prompt = source.buildFetchPrompt(config.source_config);
		const model = config.model || MODEL_MAP[config.effort || "medium"];

		try {
			const result = await execa(
				"claude",
				["-p", prompt, "--model", model, "--output-format", "text"],
				{ timeout: 2 * 60 * 1000, reject: false },
			);

			logger.log(`Pick response: ${result.stdout.trim().substring(0, 200)}`);
			return source.parseIssueId(result.stdout);
		} catch (err) {
			logger.error(`Failed to pick issue: ${err instanceof Error ? err.message : String(err)}`);
			return null;
		}
	}
}
