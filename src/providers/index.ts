import type { FallbackResult, ModelAttempt, Provider, ProviderName, RunOptions } from "../types.js";
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

const ELIGIBLE_ERROR_PATTERNS = [
	/429/i,
	/quota/i,
	/rate.?limit/i,
	/too many requests/i,
	/resource.?exhausted/i,
	/overloaded/i,
	/unavailable/i,
	/not.?found.*model/i,
	/model.*not.?found/i,
	/does not exist/i,
	/ETIMEDOUT/,
	/ECONNREFUSED/,
	/ECONNRESET/,
	/ENOTFOUND/,
	/timeout/i,
	/timed?\s*out/i,
	/network.?error/i,
	/not installed/i,
	/not in PATH/i,
	/command not found/i,
];

export function isEligibleForFallback(output: string): boolean {
	return ELIGIBLE_ERROR_PATTERNS.some((pattern) => pattern.test(output));
}

export async function runWithFallback(
	models: ProviderName[],
	prompt: string,
	opts: RunOptions,
): Promise<FallbackResult> {
	const attempts: ModelAttempt[] = [];

	for (const model of models) {
		const provider = createProvider(model);
		const available = await provider.isAvailable();

		if (!available) {
			attempts.push({
				provider: model,
				success: false,
				error: `Provider "${model}" is not installed or not in PATH`,
				duration: 0,
			});
			continue;
		}

		const result = await provider.run(prompt, opts);

		if (result.success) {
			attempts.push({
				provider: model,
				success: true,
				duration: result.duration,
			});
			return {
				success: true,
				output: result.output,
				duration: result.duration,
				providerUsed: model,
				attempts,
			};
		}

		const eligible = isEligibleForFallback(result.output);
		attempts.push({
			provider: model,
			success: false,
			error: eligible ? "Eligible error (quota/unavailable/timeout)" : "Non-eligible error",
			duration: result.duration,
		});

		if (!eligible) {
			return {
				success: false,
				output: result.output,
				duration: result.duration,
				providerUsed: model,
				attempts,
			};
		}
	}

	const totalDuration = attempts.reduce((sum, a) => sum + a.duration, 0);
	return {
		success: false,
		output: formatAttemptsReport(attempts),
		duration: totalDuration,
		providerUsed: attempts[attempts.length - 1]?.provider ?? models[0] ?? "claude",
		attempts,
	};
}

function formatAttemptsReport(attempts: ModelAttempt[]): string {
	const lines = ["All models exhausted. Attempt history:"];
	for (const [i, a] of attempts.entries()) {
		const status = a.success ? "OK" : "FAILED";
		const error = a.error ? ` — ${a.error}` : "";
		const duration = a.duration > 0 ? ` (${Math.round(a.duration / 1000)}s)` : "";
		lines.push(`  ${i + 1}. ${a.provider}: ${status}${error}${duration}`);
	}
	return lines.join("\n");
}
