import { formatError } from "../errors.js";
import { fetchPrFeedback, formatPrFeedbackEntry } from "../git/pr-feedback.js";
import * as logger from "../output/logger.js";
import { appendRawEntry } from "../session/guardrails.js";
import { clearPrUrl } from "../session/pr-cache.js";
import type { LisaConfig, Source } from "../types/index.js";
import { kanbanEmitter } from "../ui/state.js";

/**
 * Checks if previously-created PRs for this issue were closed without merge.
 * If so, fetches review comments and injects them into guardrails for future runs.
 */
export async function injectRejectedPrFeedback(
	workspace: string,
	issueId: string,
	prUrls: string[],
): Promise<void> {
	for (const prUrl of prUrls) {
		try {
			const feedback = await fetchPrFeedback(prUrl);
			if (feedback.state !== "closed") continue;

			const hasAnyFeedback = feedback.reviews.length > 0 || feedback.comments.length > 0;
			if (!hasAnyFeedback) continue;

			const date = new Date().toISOString().slice(0, 10);
			const entryText = formatPrFeedbackEntry(feedback, issueId, date);
			appendRawEntry(workspace, entryText);
			logger.ok(`Injected PR review feedback for ${issueId} into guardrails`);
		} catch (err) {
			logger.warn(`Could not check PR feedback for ${issueId}: ${formatError(err)}`);
		}
	}
	clearPrUrl(workspace, issueId);
}

export async function recoverOrphanIssues(source: Source, config: LisaConfig): Promise<void> {
	// If in_progress is empty or matches pick_from (e.g. GitHub/GitLab Issues both use "open"),
	// orphan recovery would loop infinitely — the updateStatus call would be a no-op and the same
	// issue would be found again on the next iteration.
	if (!config.source_config.in_progress) return;
	if (config.source_config.in_progress === config.source_config.pick_from) return;

	const orphanConfig = {
		...config.source_config,
		pick_from: config.source_config.in_progress,
	};

	while (true) {
		let orphan: Awaited<ReturnType<typeof source.fetchNextIssue>>;
		try {
			orphan = await source.fetchNextIssue(orphanConfig);
		} catch (err) {
			logger.warn(`Failed to check for orphan issues: ${formatError(err)}`);
			break;
		}

		if (!orphan) break;

		logger.warn(
			`Found orphan issue ${orphan.id} stuck in "${config.source_config.in_progress}". Reverting to "${config.source_config.pick_from}".`,
		);
		try {
			await source.updateStatus(orphan.id, config.source_config.pick_from, config.source_config);
			kanbanEmitter.emit("issue:reverted", orphan.id);
			logger.ok(`Recovered orphan ${orphan.id}`);
		} catch (err) {
			logger.error(`Failed to recover orphan ${orphan.id}: ${formatError(err)}`);
			break;
		}
	}
}
