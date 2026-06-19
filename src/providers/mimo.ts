import type { Provider, RunOptions, RunResult } from "../types/index.js";
import {
	formatError,
	isCommandAvailable,
	type ProviderProcessConfig,
	runProviderProcess,
	validateShellArg,
} from "./run-provider.js";

const MIMO_ERROR_PATTERN = /^Error /;

export class MimoProvider implements Provider {
	name = "mimo" as const;

	async isAvailable(): Promise<boolean> {
		return isCommandAvailable("mimo");
	}

	async run(prompt: string, opts: RunOptions): Promise<RunResult> {
		try {
			if (opts.model) validateShellArg(opts.model, "model");
			const modelFlag = opts.model ? `--model ${opts.model}` : "";

			const config: ProviderProcessConfig = {
				name: "mimo",
				buildCommand: (promptCatExpr) =>
					`mimo run --dangerously-skip-permissions ${modelFlag} ${promptCatExpr}`,
				logLine: `mimo run --dangerously-skip-permissions ${modelFlag || "(default model)"}`,
				kanbanLine: `$ mimo run --dangerously-skip-permissions ${modelFlag || "(default model)"} <prompt: ${prompt.length} chars>\n`,
				errorPattern: MIMO_ERROR_PATTERN,
			};

			return await runProviderProcess(config, prompt, opts);
		} catch (err) {
			return { success: false, output: formatError(err), duration: 0 };
		}
	}
}
