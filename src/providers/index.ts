import type { Provider, ProviderName } from "../types.js";
import { ClaudeProvider } from "./claude.js";
import { GeminiProvider } from "./gemini.js";
import { OpenCodeProvider } from "./opencode.js";

const providers: Record<ProviderName, () => Provider> = {
	claude: () => new ClaudeProvider(),
	gemini: () => new GeminiProvider(),
	opencode: () => new OpenCodeProvider(),
};

export function createProvider(name: ProviderName): Provider {
	const factory = providers[name];
	if (!factory) {
		throw new Error(`Unknown provider: ${name}. Available: ${Object.keys(providers).join(", ")}`);
	}
	return factory();
}
