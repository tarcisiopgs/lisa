import { resolve } from "node:path";
import { formatLabels } from "../config.js";
import { formatError } from "../errors.js";
import { resolveFirstDependency } from "../git/dependency.js";
import { determineRepoPath } from "../git/worktree.js";
import * as logger from "../output/logger.js";
import { notify, resetTitle, setTitle, startSpinner, stopSpinner } from "../output/terminal.js";
import { getLogsDir } from "../paths.js";
import { isCompleteProviderExhaustion } from "../providers/index.js";
import { loadPrUrls } from "../session/pr-cache.js";
import type { LisaConfig, ModelSpec, Source } from "../types/index.js";
import { kanbanEmitter } from "../ui/state.js";
import { runBranchSession } from "./branch-session.js";
import {
	checkIssueSpec,
	checkoutBaseBranches,
	moveToInProgress,
	resolveBaseBranch,
	revertIssueStatus,
	sleep,
	waitIfPaused,
} from "./helpers.js";
import type { LoopOptions } from "./models.js";
import { WATCH_POLL_INTERVAL_MS } from "./models.js";
import { injectRejectedPrFeedback } from "./recovery.js";
import type { SessionResult } from "./result.js";
import { handleSessionResult } from "./result.js";
import {
	activeCleanups,
	hasUserQuitFromWatchPrompt,
	isShuttingDown,
	providerPausedSet,
	userKilledSet,
	userSkippedSet,
	waitForResume,
} from "./state.js";
import { runWorktreeSession } from "./worktree-session.js";

export async function runSequentialLoop(
	config: LisaConfig,
	source: Source,
	models: ModelSpec[],
	workspace: string,
	opts: LoopOptions,
): Promise<void> {
	let session = 0;
	const loopStart = Date.now();
	let completedCount = 0;
	let consecutiveFetchErrors = 0;
	const MAX_CONSECUTIVE_FETCH_ERRORS = 3;
	let consecutiveExhaustions = 0;
	const MAX_CONSECUTIVE_EXHAUSTIONS = 3;

	while (true) {
		session++;

		if (opts.limit > 0 && session > opts.limit) {
			logger.ok(`Reached limit of ${opts.limit} issues. Stopping.`);
			break;
		}

		const timestamp = new Date().toISOString().replace(/[:.]/g, "-").substring(0, 19);
		const logFile = resolve(getLogsDir(workspace), `session_${session}_${timestamp}.log`);

		logger.divider(session);

		// Wait if the user has paused the loop from the TUI
		await waitIfPaused();

		// 1. Fetch issue — either by ID or from queue
		startSpinner("fetching issue...");
		if (opts.issueId) {
			logger.log(`Fetching issue '${opts.issueId}' from ${config.source}...`);
		} else {
			logger.log(
				`Fetching next '${formatLabels(config.source_config)}' issue from ${config.source}...`,
			);
		}

		if (opts.dryRun) {
			stopSpinner();
			if (opts.issueId) {
				logger.log(`[dry-run] Would fetch issue '${opts.issueId}' from ${config.source}`);
			} else {
				logger.log(
					`[dry-run] Would fetch issue from ${config.source} (${config.source_config.scope}/${config.source_config.project})`,
				);
			}
			logger.log(`[dry-run] Workflow mode: ${config.workflow}`);
			logger.log(
				`[dry-run] Models priority: ${models.map((m) => (m.model ? `${m.provider}/${m.model}` : m.provider)).join(" → ")}`,
			);
			logger.log("[dry-run] Then implement, push, create PR, and update issue status");
			break;
		}

		let issue: Awaited<ReturnType<typeof source.fetchNextIssue>>;
		try {
			issue = opts.issueId
				? await source.fetchIssueById(opts.issueId)
				: await source.fetchNextIssue(config.source_config);
			consecutiveFetchErrors = 0;
		} catch (err) {
			stopSpinner();
			consecutiveFetchErrors++;
			logger.error(`Failed to fetch issues: ${formatError(err)}`);
			if (opts.once || consecutiveFetchErrors >= MAX_CONSECUTIVE_FETCH_ERRORS) {
				if (consecutiveFetchErrors >= MAX_CONSECUTIVE_FETCH_ERRORS) {
					logger.error(
						`Stopping after ${MAX_CONSECUTIVE_FETCH_ERRORS} consecutive fetch failures.`,
					);
				}
				break;
			}
			setTitle("Lisa \u2014 cooling down...");
			await sleep(config.loop.cooldown * 1000);
			continue;
		}

		stopSpinner();

		if (!issue) {
			if (opts.issueId) {
				logger.error(`Issue '${opts.issueId}' not found.`);
				break;
			}

			if (opts.watch) {
				if (completedCount > 0) {
					logger.ok(`All issues resolved. Prompting user to continue watching...`);
					kanbanEmitter.emit("work:watch-prompt");
					setTitle("Lisa \u2014 all resolved");
					await waitIfPaused();
					if (hasUserQuitFromWatchPrompt() || isShuttingDown()) {
						break;
					}
					kanbanEmitter.emit("work:watch-prompt-resumed");
					logger.ok(`Resuming watch mode (polling every ${WATCH_POLL_INTERVAL_MS / 1000}s)...`);
					kanbanEmitter.emit("work:watching");
					setTitle("Lisa \u2014 watching...");
					await sleep(WATCH_POLL_INTERVAL_MS);
					kanbanEmitter.emit("work:watch-resume");
					session--;
					continue;
				}
				logger.ok(
					`No issues ready. Watching for new issues (polling every ${WATCH_POLL_INTERVAL_MS / 1000}s)...`,
				);
				kanbanEmitter.emit("work:watching");
				setTitle("Lisa \u2014 watching...");
				await sleep(WATCH_POLL_INTERVAL_MS);
				kanbanEmitter.emit("work:watch-resume");
				session--;
				continue;
			}

			// Queue empty — pause and wait for user action (plan → run)
			logger.ok(`No more issues with label '${formatLabels(config.source_config)}'.`);
			kanbanEmitter.emit("work:empty");
			setTitle("Lisa \u2014 idle");

			// Wait until the loop is resumed (e.g. after plan creates issues)
			await waitForResume();
			if (isShuttingDown() || hasUserQuitFromWatchPrompt()) {
				break;
			}
			kanbanEmitter.emit("work:resumed");
			session--;
			continue;
		}

		logger.ok(`Picked up: ${issue.id} — ${issue.title}`);
		setTitle(`Lisa \u2014 ${issue.id}`);

		// Check if a previous PR for this issue was closed without merge — inject feedback
		const cachedPrUrls = loadPrUrls(workspace, issue.id);
		if (cachedPrUrls.length > 0) {
			await injectRejectedPrFeedback(workspace, issue.id, cachedPrUrls);
		}

		// Validate minimum issue spec before accepting
		await checkIssueSpec(issue, config, source);

		// Resolve dependency if the issue has completed blockers with open PRs
		if (issue.completedBlockerIds && issue.completedBlockerIds.length > 0) {
			const repoPath = determineRepoPath(config.repos, issue, workspace) ?? workspace;
			const baseBranch = resolveBaseBranch(config, repoPath);
			startSpinner(`${issue.id} — resolving dependency...`);
			const dep = await resolveFirstDependency(repoPath, issue.completedBlockerIds, baseBranch);
			stopSpinner();
			if (dep) {
				issue.dependency = dep;
				logger.ok(
					`Dependency resolved: ${dep.issueId} → branch ${dep.branch} (${dep.changedFiles.length} changed files)`,
				);
			}
		}

		// Ensure the issue exists in the kanban (may be missing if added after initial fetch)
		kanbanEmitter.emit("issue:queued", issue);

		// Move issue to in-progress status before starting work
		const previousStatus = config.source_config.pick_from;
		kanbanEmitter.emit("issue:started", issue.id);
		await moveToInProgress(issue, source, config);

		// Register active issue for signal handler cleanup
		activeCleanups.set(issue.id, { previousStatus, source, sourceConfig: config.source_config });

		let sessionResult: SessionResult;
		try {
			sessionResult =
				config.workflow === "worktree"
					? await runWorktreeSession(config, issue, logFile, session, models, source)
					: await runBranchSession(config, issue, logFile, session, models, source);
		} catch (err) {
			stopSpinner();
			logger.error(`Unhandled error in session for ${issue.id}: ${formatError(err)}`);
			await revertIssueStatus(issue, source, config);
			activeCleanups.delete(issue.id);
			if (config.bell !== false) notify(2);
			if (opts.once) break;
			logger.log(`Cooling down ${config.loop.cooldown}s before next issue...`);
			setTitle("Lisa \u2014 cooling down...");
			await sleep(config.loop.cooldown * 1000);
			continue;
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

		if (opts.once) {
			logger.log("Single iteration mode. Exiting.");
			break;
		}

		// Check for provider exhaustion — only stop after consecutive failures
		if (
			!sessionResult.success &&
			!userKilledSet.has(issue.id) &&
			!userSkippedSet.has(issue.id) &&
			isCompleteProviderExhaustion(sessionResult.fallback.attempts)
		) {
			consecutiveExhaustions++;
			if (consecutiveExhaustions >= MAX_CONSECUTIVE_EXHAUSTIONS) {
				logger.error(
					"All providers exhausted due to infrastructure issues (quota, plan limits, or not installed). " +
						"Fix your provider configuration and restart lisa.",
				);
				break;
			}
			logger.warn(
				`Provider exhausted for ${issue.id} (${consecutiveExhaustions}/${MAX_CONSECUTIVE_EXHAUSTIONS}). Continuing with next issue.`,
			);
		} else if (sessionResult.success) {
			consecutiveExhaustions = 0;
		}

		// Clean per-issue flags
		userKilledSet.delete(issue.id);
		userSkippedSet.delete(issue.id);
		providerPausedSet.delete(issue.id);

		logger.log(`Cooling down ${config.loop.cooldown}s before next issue...`);
		setTitle("Lisa \u2014 cooling down...");
		await sleep(config.loop.cooldown * 1000);
	}

	if (completedCount > 0) {
		await checkoutBaseBranches(config, workspace);
		kanbanEmitter.emit("work:complete", {
			total: completedCount,
			duration: Date.now() - loopStart,
		});
	}
	resetTitle();
	logger.ok(`lisa finished. ${session} session(s) run.`);
}
