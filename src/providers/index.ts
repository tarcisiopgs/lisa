import type { Provider, ProviderName } from "../types.js";
import { ClaudeProvider } from "./claude.js";
import { GeminiProvider } from "./gemini.js";
import { OpenCodeProvider } from "./opencode.js";

const providers: Record<ProviderName, () => Provider> = {
	claude: () => new ClaudeProvider(),
	gemini: () => new GeminiProvider(),
	opencode: () => new OpenCodeProvider(),
};

export async function getAvailableProviders(): Promise<Provider[]> {
	const all = Object.values(providers).map((f) => f());
	const results = await Promise.all(
		all.map(async (p) => ({ provider: p, available: await p.isAvailable() })),
	);
	return results.filter((r) => r.available).map((r) => r.provider);
}

export function createProvider(name: ProviderName): Provider {
	const factory = providers[name];
	if (!factory) {
		throw new Error(`Unknown provider: ${name}. Available: ${Object.keys(providers).join(", ")}`);
	}
	return factory();
}
