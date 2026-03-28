import * as logger from "../output/logger.js";
import type { ReactionConfig, ReactionEvent, ReactionsConfig } from "../types/index.js";

export const DEFAULT_REACTIONS: Record<ReactionEvent, ReactionConfig> = {
	ci_failed: { action: "reinvoke", max_retries: 3, escalate_after: "30m" },
	changes_requested: { action: "reinvoke", max_retries: 2, escalate_after: "1h" },
	approved: { action: "notify" },
	agent_stuck: { action: "notify" },
	validation_failed: { action: "reinvoke", max_retries: 2 },
};

/**
 * Parses a duration string like "30m", "1h", or "90s" into milliseconds.
 * Returns null for invalid or undefined input.
 */
export function parseDuration(duration: string | undefined): number | null {
	if (!duration) return null;

	const match = duration.match(/^(\d+)(s|m|h)$/);
	if (!match) return null;

	const value = parseInt(match[1] as string, 10);
	const unit = match[2];

	if (unit === "s") return value * 1000;
	if (unit === "m") return value * 60 * 1000;
	if (unit === "h") return value * 60 * 60 * 1000;

	return null;
}

/**
 * Merges user-provided reaction overrides on top of the defaults for a given event.
 */
export function resolveReaction(
	event: ReactionEvent,
	userReactions: ReactionsConfig | undefined,
): ReactionConfig {
	const defaults = DEFAULT_REACTIONS[event];
	const userOverride = userReactions?.[event];
	return { ...defaults, ...userOverride };
}

/**
 * Returns true if the reaction should escalate based on retry count or elapsed time.
 */
export function shouldEscalate(
	reaction: ReactionConfig,
	attempts: number,
	firstTriggeredAt: number,
): boolean {
	if (reaction.max_retries !== undefined && attempts >= reaction.max_retries) {
		return true;
	}

	const durationMs = parseDuration(reaction.escalate_after);
	if (durationMs !== null) {
		const elapsed = Date.now() - firstTriggeredAt;
		if (elapsed >= durationMs) return true;
	}

	return false;
}

/**
 * Logs a warning notification for a reaction event.
 */
export function executeNotify(event: ReactionEvent, issueId: string, detail?: string): void {
	const base = `[reaction] ${event} for issue ${issueId}`;
	logger.warn(detail ? `${base}: ${detail}` : base);
}
