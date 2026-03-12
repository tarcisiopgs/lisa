import {
	appendEntry,
	buildGuardrailsSection,
	extractContext,
	extractErrorType,
} from "../session/guardrails.js";
import type {
	FallbackResult,
	ModelAttempt,
	ModelSpec,
	Provider,
	ProviderName,
	RunOptions,
} from "../types/index.js";
import { kanbanEmitter } from "../ui/state.js";
import { AiderProvider } from "./aider.js";
import { ClaudeProvider } from "./claude.js";
import { CodexProvider } from "./codex.js";
import { CopilotProvider } from "./copilot.js";
import { CursorProvider } from "./cursor.js";
import { GeminiProvider } from "./gemini.js";
import { GooseProvider } from "./goose.js";
import { OpenCodeProvider } from "./opencode.js";

const providers: Record<ProviderName, () => Provider> = {
	claude: () => new ClaudeProvider(),
	gemini: () => new GeminiProvider(),
	opencode: () => new OpenCodeProvider(),
	copilot: () => new CopilotProvider(),
	cursor: () => new CursorProvider(),
	goose: () => new GooseProvider(),
	aider: () => new AiderProvider(),
	codex: () => new CodexProvider(),
};

export async function getAllProvidersWithAvailability(): Promise<
	{ provider: Provider; available: boolean }[]
> {
	const all = Object.values(providers).map((f) => f());
	return Promise.all(all.map(async (p) => ({ provider: p, available: await p.isAvailable() })));
}

export function createProvider(name: string): Provider {
	const factory = providers[name as ProviderName];
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
	/fetch failed/i,
	/\btimeout\b/i,
	/\btimed?\s*out\b/i,
	/network.?error/i,
	/not installed/i,
	/not in PATH/i,
	/command not found/i,
	/lisa-overseer/i,
	/lisa-timeout/i,
	/lisa-stall/i,
	/named models unavailable/i,
	/free plans can only use/i,
	/empty commit/i,
	// Process crash patterns (OOM, fatal errors, signals)
	/heap.*out of memory/i,
	/out of memory/i,
	/FATAL ERROR/,
	/allocation failed/i,
	/segmentation fault/i,
	/\bSIGKILL\b/,
	/\bSIGABRT\b/,
	/\bSIGSEGV\b/,
];

export function isEligibleForFallback(output: string, exitCode?: number): boolean {
	if (ELIGIBLE_ERROR_PATTERNS.some((pattern) => pattern.test(output))) return true;
	// Exit codes > 128 indicate the process was killed by a signal (e.g. OOM killer,
	// SIGSEGV, SIGABRT). These are infrastructure crashes, not task-quality failures.
	if (exitCode !== undefined && exitCode > 128) return true;
	return false;
}

/**
 * Returns true when every attempt in a fallback chain failed due to provider
 * infrastructure issues (eligible errors or binary not found), meaning no
 * provider was able to attempt the task itself. In this case the loop should
 * stop rather than reverting the issue and retrying indefinitely.
 */
export function isCompleteProviderExhaustion(attempts: ModelAttempt[]): boolean {
	if (attempts.length === 0) return false;
	return attempts.every((a) => !a.success && a.error !== "Non-eligible error");
}

export async function runWithFallback(
	models: ModelSpec[],
	prompt: string,
	opts: RunOptions,
): Promise<FallbackResult> {
	const attempts: ModelAttempt[] = [];

	for (const spec of models) {
		if (opts.shouldAbort?.()) {
			break;
		}

		kanbanEmitter.emit("provider:model-changed", spec.model ?? spec.provider);

		const provider = createProvider(spec.provider);
		const available = await provider.isAvailable();

		if (!available) {
			attempts.push({
				provider: spec.provider,
				model: spec.model,
				success: false,
				error: `Provider "${spec.provider}" is not installed or not in PATH`,
				duration: 0,
			});
			continue;
		}

		const guardrailsSection = opts.guardrailsDir ? buildGuardrailsSection(opts.guardrailsDir) : "";
		const fullPrompt = guardrailsSection ? `${prompt}${guardrailsSection}` : prompt;

		const result = await provider.run(fullPrompt, { ...opts, model: spec.model });

		if (result.success || opts.earlySuccess?.()) {
			attempts.push({
				provider: spec.provider,
				model: spec.model,
				success: true,
				duration: result.duration,
			});
			return {
				success: true,
				output: result.output,
				duration: result.duration,
				providerUsed: spec.model ? `${spec.provider}/${spec.model}` : spec.provider,
				provider,
				attempts,
			};
		}

		if (opts.guardrailsDir && opts.issueId) {
			appendEntry(opts.guardrailsDir, {
				issueId: opts.issueId,
				date: new Date().toISOString().slice(0, 10),
				provider: spec.provider,
				errorType: extractErrorType(result.output),
				context: extractContext(result.output),
			});
		}

		const eligible = isEligibleForFallback(result.output, result.exitCode);
		attempts.push({
			provider: spec.provider,
			model: spec.model,
			success: false,
			error: eligible ? "Eligible error (quota/unavailable/timeout)" : "Non-eligible error",
			duration: result.duration,
		});

		if (!eligible) {
			return {
				success: false,
				output: result.output,
				duration: result.duration,
				providerUsed: spec.model ? `${spec.provider}/${spec.model}` : spec.provider,
				provider,
				attempts,
			};
		}
	}

	const totalDuration = attempts.reduce((sum, a) => sum + a.duration, 0);
	return {
		success: false,
		output: formatAttemptsReport(attempts),
		duration: totalDuration,
		providerUsed: attempts[attempts.length - 1]?.provider ?? models[0]?.provider ?? "claude",
		attempts,
	};
}

function formatAttemptsReport(attempts: ModelAttempt[]): string {
	const lines = ["All models exhausted. Attempt history:"];
	for (const [i, a] of attempts.entries()) {
		const status = a.success ? "OK" : "FAILED";
		const error = a.error ? ` — ${a.error}` : "";
		const duration = a.duration > 0 ? ` (${Math.round(a.duration / 1000)}s)` : "";
		const label = a.model ? `${a.provider}/${a.model}` : a.provider;
		lines.push(`  ${i + 1}. ${label}: ${status}${error}${duration}`);
	}
	return lines.join("\n");
}
