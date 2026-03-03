import { resolve } from "node:path";
import { formatLabels } from "../config.js";
import * as logger from "../output/logger.js";
import { notify, resetTitle, setTitle } from "../output/terminal.js";
import { getLogsDir } from "../paths.js";
import { isCompleteProviderExhaustion } from "../providers/index.js";
import { loadPrUrls } from "../session/pr-cache.js";
import type { Issue, LisaConfig, ModelSpec, Source } from "../types/index.js";
import { kanbanEmitter } from "../ui/state.js";
import { validateIssueSpec } from "../validation.js";
import { checkoutBaseBranches, sleep, waitIfPaused } from "./helpers.js";
import type { LoopOptions } from "./models.js";
import { WATCH_POLL_INTERVAL_MS } from "./models.js";
import { injectRejectedPrFeedback } from "./recovery.js";
import type { SessionResult } from "./result.js";
import { handleSessionResult } from "./result.js";
import {
	activeCleanups,
	activeProviderPids,
	hasUserQuitFromWatchPrompt,
	isShuttingDown,
	providerPausedSet,
	userKilledSet,
	userSkippedSet,
} from "./state.js";
import { runWorktreeSession } from "./worktree-session.js";

export async function runConcurrentLoop(
	config: LisaConfig,
	source: Source,
	models: ModelSpec[],
	workspace: string,
	opts: LoopOptions,
): Promise<void> {
	const concurrency = opts.concurrency;
	const loopStart = Date.now();
	let completedCount = 0;
	let sessionCounter = 0;
	let noMoreIssues = false;
	let exhausted = false;
	let consecutiveFetchErrors = 0;
	const MAX_CONSECUTIVE_FETCH_ERRORS = 3;
	const activeWorkers = new Map<string, Promise<void>>();

	const processIssue = async (issue: Issue, session: number): Promise<void> => {
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-").substring(0, 19);
		const logFile = resolve(getLogsDir(workspace), `session_${session}_${timestamp}.log`);

		logger.ok(`Picked up: ${issue.id} — ${issue.title}`);

		// Check if a previous PR for this issue was closed without merge — inject feedback
		const cachedPrUrls = loadPrUrls(workspace, issue.id);
		if (cachedPrUrls.length > 0) {
			await injectRejectedPrFeedback(workspace, issue.id, cachedPrUrls);
		}

		// Validate minimum issue spec before accepting
		const specResult = validateIssueSpec(issue, config.validation);
		if (!specResult.valid) {
			logger.warn(`Issue ${issue.id}: ${specResult.reason} — proceeding with incomplete spec`);
			try {
				await source.addLabel?.(issue.id, "needs-spec");
				logger.ok(`Added label "needs-spec" to ${issue.id}`);
			} catch (err) {
				logger.warn(
					`Failed to add label "needs-spec": ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			issue.specWarning = specResult.reason;
		}

		kanbanEmitter.emit("issue:queued", issue);

		// Move issue to in-progress
		const previousStatus = config.source_config.pick_from;
		try {
			kanbanEmitter.emit("issue:started", issue.id);
			await source.updateStatus(issue.id, config.source_config.in_progress, config.source_config);
			logger.ok(`Moved ${issue.id} to "${config.source_config.in_progress}"`);
		} catch (err) {
			logger.warn(`Failed to update status: ${err instanceof Error ? err.message : String(err)}`);
		}

		activeCleanups.set(issue.id, { previousStatus, source, sourceConfig: config.source_config });

		let sessionResult: SessionResult;
		try {
			sessionResult = await runWorktreeSession(config, issue, logFile, session, models);
		} catch (err) {
			logger.error(
				`Unhandled error in session for ${issue.id}: ${err instanceof Error ? err.message : String(err)}`,
			);
			try {
				await source.updateStatus(issue.id, previousStatus, config.source_config);
				logger.ok(`Reverted ${issue.id} to "${previousStatus}"`);
			} catch (revertErr) {
				logger.error(
					`Failed to revert status: ${revertErr instanceof Error ? revertErr.message : String(revertErr)}`,
				);
			}
			activeCleanups.delete(issue.id);
			activeProviderPids.delete(issue.id);
			if (config.bell !== false) notify(2);
			return;
		}

		const completed = await handleSessionResult(
			sessionResult,
			issue,
			previousStatus,
			source,
			config,
			opts,
		);
		if (completed) completedCount++;

		if (
			!sessionResult.success &&
			!userKilledSet.has(issue.id) &&
			!userSkippedSet.has(issue.id) &&
			isCompleteProviderExhaustion(sessionResult.fallback.attempts)
		) {
			exhausted = true;
			logger.error(
				"All providers exhausted due to infrastructure issues. " +
					"Fix your provider configuration and restart lisa.",
			);
		}

		// Cleanup per-issue state
		userKilledSet.delete(issue.id);
		userSkippedSet.delete(issue.id);
		providerPausedSet.delete(issue.id);
		activeProviderPids.delete(issue.id);
		activeCleanups.delete(issue.id);
	};

	while (!noMoreIssues && !exhausted) {
		await waitIfPaused();

		// Fill available slots
		while (activeWorkers.size < concurrency && !noMoreIssues && !exhausted) {
			sessionCounter++;

			if (opts.limit > 0 && sessionCounter > opts.limit) {
				logger.ok(`Reached limit of ${opts.limit} issues. Stopping.`);
				noMoreIssues = true;
				break;
			}

			// Fetch next issue
			let issue: Issue | null;
			try {
				issue = await source.fetchNextIssue(config.source_config);
				consecutiveFetchErrors = 0;
			} catch (err) {
				consecutiveFetchErrors++;
				logger.error(`Failed to fetch issues: ${err instanceof Error ? err.message : String(err)}`);
				sessionCounter--; // Don't count failed fetches
				if (consecutiveFetchErrors >= MAX_CONSECUTIVE_FETCH_ERRORS) {
					logger.error(
						`Stopping after ${MAX_CONSECUTIVE_FETCH_ERRORS} consecutive fetch failures.`,
					);
					noMoreIssues = true;
				} else {
					await sleep(config.loop.cooldown * 1000);
				}
				break;
			}

			if (!issue) {
				if (opts.watch) {
					if (activeWorkers.size === 0) {
						if (completedCount > 0) {
							logger.ok(`All issues resolved. Prompting user to continue watching...`);
							kanbanEmitter.emit("work:watch-prompt");
							setTitle("Lisa \u2014 all resolved");
							await waitIfPaused();
							if (hasUserQuitFromWatchPrompt() || isShuttingDown()) {
								noMoreIssues = true;
								break;
							}
							kanbanEmitter.emit("work:watch-prompt-resumed");
							logger.ok(`Resuming watch mode (polling every ${WATCH_POLL_INTERVAL_MS / 1000}s)...`);
						}
						logger.ok(
							`No issues ready. Watching for new issues (polling every ${WATCH_POLL_INTERVAL_MS / 1000}s)...`,
						);
						kanbanEmitter.emit("work:watching");
						setTitle("Lisa \u2014 watching...");
						await sleep(WATCH_POLL_INTERVAL_MS);
						kanbanEmitter.emit("work:watch-resume");
					}
					sessionCounter--; // Don't count this as a session
					break; // Break inner fill loop; noMoreIssues stays false → outer while re-enters
				}
				if (activeWorkers.size === 0) {
					logger.ok(`No more issues with label '${formatLabels(config.source_config)}'. Done.`);
					if (sessionCounter === 1) {
						kanbanEmitter.emit("work:empty");
					}
				}
				noMoreIssues = true;
				break;
			}

			const session = sessionCounter;
			const promise = processIssue(issue, session).finally(() => {
				activeWorkers.delete(issue.id);
			});
			activeWorkers.set(issue.id, promise);
		}

		if (activeWorkers.size === 0 && !opts.watch) break;
		if (activeWorkers.size === 0) continue;

		// Wait for at least one worker to finish before trying to fill again
		await Promise.race([...activeWorkers.values()]);

		// Brief cooldown before filling next slot
		if (!noMoreIssues && !exhausted && activeWorkers.size < concurrency) {
			await sleep(1000);
		}
	}

	// Wait for remaining workers to finish
	if (activeWorkers.size > 0) {
		logger.log(`Waiting for ${activeWorkers.size} active worker(s) to finish...`);
		await Promise.allSettled([...activeWorkers.values()]);
	}

	if (completedCount > 0) {
		await checkoutBaseBranches(config, workspace);
		kanbanEmitter.emit("work:complete", {
			total: completedCount,
			duration: Date.now() - loopStart,
		});
	}
	resetTitle();
	logger.ok(`lisa finished. ${sessionCounter} session(s) run, ${completedCount} completed.`);
}
