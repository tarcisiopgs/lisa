import type { Provider, RunOptions, RunResult } from "../types/index.js";
import {
	formatError,
	isCommandAvailable,
	type ProviderProcessConfig,
	runProviderProcess,
	validateShellArg,
} from "./run-provider.js";

// Gemini-specific: these prefixes appear on every failed tool call and API error
const GEMINI_ERROR_PATTERN = /^Error (executing tool|generating content)/;

export class GeminiProvider implements Provider {
	name = "gemini" as const;

	async isAvailable(): Promise<boolean> {
		return isCommandAvailable("gemini");
	}

	async run(prompt: string, opts: RunOptions): Promise<RunResult> {
		try {
			if (opts.model) validateShellArg(opts.model, "model");
			const modelFlag = opts.model ? `--model ${opts.model}` : "";

			const config: ProviderProcessConfig = {
				name: "gemini",
				buildCommand: (promptCatExpr) => `gemini --yolo ${modelFlag} -p ${promptCatExpr}`,
				logLine: `gemini --yolo ${modelFlag || "(default model)"} -p`,
				kanbanLine: `$ gemini --yolo ${modelFlag || "(default model)"} -p <prompt: ${prompt.length} chars>\n`,
				errorPattern: GEMINI_ERROR_PATTERN,
			};

			return await runProviderProcess(config, prompt, opts);
		} catch (err) {
			return { success: false, output: formatError(err), duration: 0 };
		}
	}
}
