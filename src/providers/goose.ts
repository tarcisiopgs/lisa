import type { Provider, RunOptions, RunResult } from "../types/index.js";
import {
	formatError,
	isCommandAvailable,
	type ProviderProcessConfig,
	runProviderProcess,
	validateShellArg,
} from "./run-provider.js";

export class GooseProvider implements Provider {
	name = "goose" as const;

	async isAvailable(): Promise<boolean> {
		return isCommandAvailable("goose");
	}

	async run(prompt: string, opts: RunOptions): Promise<RunResult> {
		try {
			// Pass --provider if GOOSE_PROVIDER env var is set, so goose doesn't panic
			// with "No provider configured" when the user hasn't run `goose configure`.
			let providerFlag = "";
			if (process.env.GOOSE_PROVIDER) {
				validateShellArg(process.env.GOOSE_PROVIDER, "GOOSE_PROVIDER");
				providerFlag = `--provider ${process.env.GOOSE_PROVIDER}`;
			}
			if (opts.model) validateShellArg(opts.model, "model");
			const modelFlag = opts.model ? `--model ${opts.model}` : "";

			const config: ProviderProcessConfig = {
				name: "goose",
				buildCommand: (promptCatExpr) =>
					`goose run ${providerFlag} ${modelFlag} --text ${promptCatExpr}`,
				logLine: `goose run ${providerFlag} ${modelFlag || "(default model)"} --text`,
				kanbanLine: `$ goose run ${providerFlag} ${modelFlag || "(default model)"} --text <prompt: ${prompt.length} chars>\n`,
				errorPattern: /^Error /,
			};

			return await runProviderProcess(config, prompt, opts);
		} catch (err) {
			return { success: false, output: formatError(err), duration: 0 };
		}
	}
}
