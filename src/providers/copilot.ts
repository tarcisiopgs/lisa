import type { Provider, RunOptions, RunResult } from "../types/index.js";
import {
	formatError,
	isCommandAvailable,
	type ProviderProcessConfig,
	runProviderProcess,
	validateShellArg,
} from "./run-provider.js";

export class CopilotProvider implements Provider {
	name = "copilot" as const;

	async isAvailable(): Promise<boolean> {
		return isCommandAvailable("copilot", ["version"]);
	}

	async run(prompt: string, opts: RunOptions): Promise<RunResult> {
		try {
			if (opts.model) validateShellArg(opts.model, "model");
			const modelFlag = opts.model ? `--model ${opts.model}` : "";

			const config: ProviderProcessConfig = {
				name: "copilot",
				buildCommand: (promptCatExpr) =>
					`copilot --allow-all --no-alt-screen ${modelFlag} -p ${promptCatExpr}`,
				logLine: `copilot --allow-all --no-alt-screen ${modelFlag || "(default model)"} -p`,
				kanbanLine: `$ copilot --allow-all --no-alt-screen ${modelFlag || "(default model)"} -p <prompt: ${prompt.length} chars>\n`,
				errorPattern: /^Error /,
			};

			return await runProviderProcess(config, prompt, opts);
		} catch (err) {
			return { success: false, output: formatError(err), duration: 0 };
		}
	}
}
