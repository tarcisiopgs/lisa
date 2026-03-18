import type { Provider, RunOptions, RunResult } from "../types/index.js";
import {
	formatError,
	isCommandAvailable,
	type ProviderProcessConfig,
	runProviderProcess,
	validateShellArg,
} from "./run-provider.js";

export class OpenCodeProvider implements Provider {
	name = "opencode" as const;

	async isAvailable(): Promise<boolean> {
		return isCommandAvailable("opencode");
	}

	async run(prompt: string, opts: RunOptions): Promise<RunResult> {
		try {
			if (opts.model) validateShellArg(opts.model, "model");
			const modelFlag = opts.model ? `--model ${opts.model}` : "";

			const config: ProviderProcessConfig = {
				name: "opencode",
				buildCommand: (promptCatExpr) => `opencode run ${modelFlag} ${promptCatExpr}`,
				logLine: `opencode run ${modelFlag || "(default model)"}`,
				kanbanLine: `$ opencode run ${modelFlag || "(default model)"} <prompt: ${prompt.length} chars>\n`,
				errorPattern: /^Error /,
			};

			return await runProviderProcess(config, prompt, opts);
		} catch (err) {
			return { success: false, output: formatError(err), duration: 0 };
		}
	}
}
