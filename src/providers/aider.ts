import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider, RunOptions, RunResult } from "../types/index.js";
import { escapeShellPath } from "./output-buffer.js";
import {
	formatError,
	isCommandAvailable,
	type ProviderProcessConfig,
	runProviderProcess,
	validateShellArg,
} from "./run-provider.js";

// Aider reads these env vars to authenticate with LLM providers.
// OAuth-based auth (e.g. Gemini CLI) is not supported — a direct API key is required.
const AIDER_API_KEY_ENV_VARS = [
	"OPENAI_API_KEY",
	"ANTHROPIC_API_KEY",
	"GEMINI_API_KEY",
	"GROQ_API_KEY",
	"OPENROUTER_API_KEY",
	"COHERE_API_KEY",
	"MISTRAL_API_KEY",
	"DEEPSEEK_API_KEY",
	"AZURE_API_KEY",
	"XAI_API_KEY",
];

export class AiderProvider implements Provider {
	name = "aider" as const;

	async isAvailable(): Promise<boolean> {
		return isCommandAvailable("aider");
	}

	async run(prompt: string, opts: RunOptions): Promise<RunResult> {
		// Fail fast if no API key is set — aider would otherwise try to open a browser
		// for OAuth auth, which hangs in non-interactive environments.
		const hasApiKey = AIDER_API_KEY_ENV_VARS.some((v) => process.env[v]);
		if (!hasApiKey) {
			return {
				success: false,
				output: `Aider requires a direct LLM API key. Set one of: ${AIDER_API_KEY_ENV_VARS.join(", ")}`,
				duration: 0,
			};
		}

		try {
			if (opts.model) validateShellArg(opts.model, "model");
			const modelFlag = opts.model ? `--model ${opts.model}` : "";

			// Aider uses --message-file instead of $(cat ...), so we create our own prompt file
			// that persists alongside the one created by runProviderProcess (which is unused by aider).
			const aiderTmpDir = mkdtempSync(join(tmpdir(), "lisa-aider-"));
			const aiderPromptFile = join(aiderTmpDir, "prompt.md");
			writeFileSync(aiderPromptFile, prompt, { encoding: "utf-8", mode: 0o600 });

			const config: ProviderProcessConfig = {
				name: "aider",
				buildCommand: () =>
					`aider --message-file '${escapeShellPath(aiderPromptFile)}' --yes-always ${modelFlag}`,
				logLine: `aider --message-file --yes-always ${modelFlag || "(default model)"}`,
				kanbanLine: `$ aider --message-file --yes-always ${modelFlag || "(default model)"} <prompt: ${prompt.length} chars>\n`,
				errorPattern: /^Error /,
			};

			try {
				return await runProviderProcess(config, prompt, opts);
			} finally {
				try {
					rmSync(aiderTmpDir, { recursive: true, force: true });
				} catch {}
			}
		} catch (err) {
			return { success: false, output: formatError(err), duration: 0 };
		}
	}
}
