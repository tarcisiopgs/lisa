import type { Provider, RunOptions, RunResult } from "../types/index.js";
import {
	formatError,
	isCommandAvailable,
	type ProviderProcessConfig,
	runProviderProcess,
	validateShellArg,
} from "./run-provider.js";

export class CodexProvider implements Provider {
	name = "codex" as const;

	async isAvailable(): Promise<boolean> {
		return isCommandAvailable("codex");
	}

	async run(prompt: string, opts: RunOptions): Promise<RunResult> {
		try {
			if (opts.model) validateShellArg(opts.model, "model");
			const modelFlag = opts.model ? `--model ${opts.model}` : "";

			const config: ProviderProcessConfig = {
				name: "codex",
				buildCommand: (promptCatExpr) =>
					`codex exec --dangerously-bypass-approvals-and-sandbox --ephemeral ${modelFlag} ${promptCatExpr}`,
				logLine: `codex exec --dangerously-bypass-approvals-and-sandbox --ephemeral ${modelFlag || "(default model)"}`,
				kanbanLine: `$ codex exec --dangerously-bypass-approvals-and-sandbox --ephemeral ${modelFlag || "(default model)"} <prompt: ${prompt.length} chars>\n`,
				errorPattern: /^Error /,
				extraEnv: { CODEX_QUIET_MODE: "1" },
			};

			return await runProviderProcess(config, prompt, opts);
		} catch (err) {
			return { success: false, output: formatError(err), duration: 0 };
		}
	}
}
