import { resolve } from "node:path";
import { getRemoveLabel } from "../config.js";
import * as logger from "../output/logger.js";
import { stopSpinner } from "../output/terminal.js";
import { storePrUrl } from "../session/pr-cache.js";
import type { FallbackResult, Issue, LisaConfig, Source } from "../types/index.js";
import { kanbanEmitter } from "../ui/state.js";
import type { LoopOptions } from "./models.js";
import { activeCleanups, providerPausedSet, userKilledSet, userSkippedSet } from "./state.js";

export interface SessionResult {
	success: boolean;
	providerUsed: string;
	prUrls: string[];
	fallback: FallbackResult;
}

export async function handleSessionResult(
	sessionResult: SessionResult,
	issue: Issue,
	previousStatus: string,
	source: Source,
	config: LisaConfig,
	opts: LoopOptions,
): Promise<boolean> {
	if (!sessionResult.success) {
		if (userKilledSet.has(issue.id)) {
			providerPausedSet.delete(issue.id);
			logger.warn(`Issue ${issue.id} killed by user.`);
			try {
				await source.updateStatus(issue.id, previousStatus, config.source_config);
				logger.ok(`Reverted ${issue.id} to "${previousStatus}"`);
			} catch (err) {
				logger.error(
					`Failed to revert status: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			kanbanEmitter.emit("issue:killed", issue.id);
			activeCleanups.delete(issue.id);
			if (config.bell !== false) {
				const { notify } = await import("../output/terminal.js");
				notify();
			}
			return false;
		}

		if (userSkippedSet.has(issue.id)) {
			providerPausedSet.delete(issue.id);
			logger.warn(`Issue ${issue.id} skipped by user.`);
			try {
				await source.updateStatus(issue.id, previousStatus, config.source_config);
				logger.ok(`Reverted ${issue.id} to "${previousStatus}"`);
			} catch (err) {
				logger.error(
					`Failed to revert status: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			kanbanEmitter.emit("issue:skipped", issue.id);
			activeCleanups.delete(issue.id);
			if (config.bell !== false) {
				const { notify } = await import("../output/terminal.js");
				notify();
			}
			return false;
		}

		// All models failed
		logger.error(`All models failed for ${issue.id}. Reverting to "${previousStatus}".`);
		logAttemptHistory(sessionResult);
		try {
			await source.updateStatus(issue.id, previousStatus, config.source_config);
			logger.ok(`Reverted ${issue.id} to "${previousStatus}"`);
			kanbanEmitter.emit("issue:reverted", issue.id);
		} catch (err) {
			logger.error(`Failed to revert status: ${err instanceof Error ? err.message : String(err)}`);
		}
		activeCleanups.delete(issue.id);
		return false;
	}

	logger.ok(`Completed with provider: ${sessionResult.providerUsed}`);

	// Only move to done if PRs were actually created
	if (sessionResult.prUrls.length === 0) {
		logger.warn(
			`Session succeeded but no PRs created for ${issue.id}. Reverting to "${previousStatus}".`,
		);
		try {
			await source.updateStatus(issue.id, previousStatus, config.source_config);
			logger.ok(`Reverted ${issue.id} to "${previousStatus}"`);
			kanbanEmitter.emit("issue:reverted", issue.id);
		} catch (err) {
			logger.error(`Failed to revert status: ${err instanceof Error ? err.message : String(err)}`);
		}
		activeCleanups.delete(issue.id);
		return false;
	}

	// Attach PR links and cache URLs for potential future feedback injection
	const workspace = resolve(config.workspace);
	for (const prUrl of sessionResult.prUrls) {
		try {
			await source.attachPullRequest(issue.id, prUrl);
			logger.ok(`Attached PR to ${issue.id}`);
		} catch (err) {
			logger.warn(`Failed to attach PR: ${err instanceof Error ? err.message : String(err)}`);
		}
		try {
			storePrUrl(workspace, issue.id, prUrl);
		} catch {
			// Non-fatal — PR cache is best-effort
		}
	}

	// Move kanban card as soon as the PR exists — status update is best-effort bookkeeping
	for (const prUrl of sessionResult.prUrls) {
		kanbanEmitter.emit("issue:done", issue.id, prUrl);
	}

	// Update issue status + remove label
	try {
		const doneStatus = config.source_config.done;
		const labelToRemove = opts.issueId ? undefined : getRemoveLabel(config.source_config);
		await source.completeIssue(issue.id, doneStatus, labelToRemove, config.source_config);
		logger.ok(`Updated ${issue.id} status to "${doneStatus}"`);
		if (labelToRemove) {
			logger.ok(`Removed label "${labelToRemove}" from ${issue.id}`);
		}
	} catch (err) {
		logger.error(`Failed to complete issue: ${err instanceof Error ? err.message : String(err)}`);
	}

	activeCleanups.delete(issue.id);
	stopSpinner(`\u2713 Lisa \u2014 ${issue.id} \u2014 PR created`);
	return true;
}

export function logAttemptHistory(result: SessionResult): void {
	for (const [i, attempt] of result.fallback.attempts.entries()) {
		const status = attempt.success ? "OK" : "FAILED";
		const error = attempt.error ? ` — ${attempt.error}` : "";
		const duration = attempt.duration > 0 ? ` (${Math.round(attempt.duration / 1000)}s)` : "";
		logger.warn(`  Attempt ${i + 1}: ${attempt.provider} ${status}${error}${duration}`);
	}
}
