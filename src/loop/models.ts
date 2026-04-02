import * as logger from "../output/logger.js";
import type { LisaConfig, ModelSpec } from "../types/index.js";

export interface LoopOptions {
	once: boolean;
	watch: boolean;
	limit: number;
	dryRun: boolean;
	issueId?: string;
	concurrency: number;
	onBeforeExit?: () => void;
	initialCards?: Array<{
		id: string;
		column: string;
		hasError?: boolean;
		skipped?: boolean;
		killed?: boolean;
	}>;
}

export const WATCH_POLL_INTERVAL_MS = 60_000;

export function resolveModels(config: LisaConfig): ModelSpec[] {
	const providerModels = config.provider_options?.[config.provider]?.models;

	if (!providerModels || providerModels.length === 0) {
		return [{ provider: config.provider }];
	}
	const knownProviders = new Set<string>([
		"claude",
		"gemini",
		"opencode",
		"copilot",
		"cursor",
		"goose",
		"aider",
		"codex",
		"kilo",
	]);
	for (const m of providerModels) {
		if (knownProviders.has(m) && m !== config.provider) {
			logger.warn(
				`Model "${m}" looks like a provider name but provider is "${config.provider}". ` +
					`Since v1.4.0, "models" lists model names within the configured provider, not provider names. ` +
					`Update your .lisa/config.yaml.`,
			);
		}
	}

	// Warn about model names that look like provider-prefixed identifiers (e.g. "opencode/model-name")
	// which may not be the format the provider CLI expects
	for (const m of providerModels) {
		if (m.includes("/") && m.startsWith(`${config.provider}/`)) {
			logger.warn(
				`Model "${m}" starts with the provider name "${config.provider}/". ` +
					`Most provider CLIs expect just the model name (e.g. "${m.slice(config.provider.length + 1)}"). ` +
					`If the provider fails silently, try removing the "${config.provider}/" prefix.`,
			);
		}
	}

	if (config.provider === "cursor") {
		const hasAuto = providerModels.some((m: string) => m.toLowerCase() === "auto");
		if (!hasAuto) {
			logger.warn(
				"Cursor Free plan detected (or model not set to 'auto'). Forcing 'auto' model. " +
					"Set model to 'auto' explicitly in .lisa/config.yaml to silence this warning.",
			);
			return [{ provider: config.provider, model: "auto" }];
		}
	}

	return providerModels.map((m: string) => ({
		provider: config.provider,
		model: m === config.provider ? undefined : m,
	}));
}
