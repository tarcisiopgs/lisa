import type { Provider, RunOptions, RunResult } from "../types/index.js";
import {
	formatError,
	isCommandAvailable,
	type ProviderProcessConfig,
	runProviderProcess,
} from "./run-provider.js";

const KILO_ERROR_PATTERN = /^Error /;

export class KiloProvider implements Provider {
	name = "kilo" as const;

	async isAvailable(): Promise<boolean> {
		return isCommandAvailable("kilo");
	}

	async run(prompt: string, opts: RunOptions): Promise<RunResult> {
		try {
			const config: ProviderProcessConfig = {
				name: "kilo",
				buildCommand: (promptCatExpr) => `kilo run --auto ${promptCatExpr}`,
				logLine: "kilo run --auto",
				kanbanLine: `$ kilo run --auto <prompt: ${prompt.length} chars>\n`,
				errorPattern: KILO_ERROR_PATTERN,
			};

			return await runProviderProcess(config, prompt, opts);
		} catch (err) {
			return { success: false, output: formatError(err), duration: 0 };
		}
	}
}
