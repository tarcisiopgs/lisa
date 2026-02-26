import { appendFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { execa } from "execa";
import { formatLabels, getRemoveLabel } from "./config.js";
import { analyzeProject } from "./context.js";
import { resolveFirstDependency } from "./git/dependency.js";
import { appendPrAttribution } from "./git/github.js";
import {
	createWorktree,
	determineRepoPath,
	generateBranchName,
	removeWorktree,
} from "./git/worktree.js";
import * as logger from "./output/logger.js";
import { notify, resetTitle, setTitle, startSpinner, stopSpinner } from "./output/terminal.js";
import { ensureCacheDir, getLogsDir, getManifestPath, rotateLogFiles } from "./paths.js";
import {
	buildImplementPrompt,
	buildNativeWorktreePrompt,
	buildPlanningPrompt,
	buildScopedImplementPrompt,
	detectPackageManager,
	detectTestRunner,
	type PreviousStepResult,
} from "./prompt.js";
import {
	createProvider,
	isCompleteProviderExhaustion,
	runWithFallback,
} from "./providers/index.js";
import { migrateGuardrails } from "./session/guardrails.js";
import { createSource } from "./sources/index.js";
import type {
	ExecutionPlan,
	FallbackResult,
	Issue,
	LisaConfig,
	ModelSpec,
	PlanStep,
	Source,
} from "./types/index.js";
import { kanbanEmitter } from "./ui/state.js";
import { validateIssueSpec } from "./validation.js";

// === Per-issue state maps for concurrent execution ===
const activeCleanups = new Map<string, { previousStatus: string; source: Source }>();
const activeProviderPids = new Map<string, number>();
const providerPausedSet = new Set<string>();
const userKilledSet = new Set<string>();
const userSkippedSet = new Set<string>();

let shuttingDown = false;
let loopPaused = false;

kanbanEmitter.on("loop:pause", () => {
	loopPaused = true;
});
kanbanEmitter.on("loop:resume", () => {
	loopPaused = false;
});

kanbanEmitter.on("loop:pause-provider", (issueId?: string) => {
	if (issueId) {
		// Pause a specific issue's provider
		const pid = activeProviderPids.get(issueId);
		if (pid) {
			try {
				process.kill(pid, "SIGSTOP");
			} catch {}
			providerPausedSet.add(issueId);
		}
	} else {
		// Pause ALL active providers
		for (const [id, pid] of activeProviderPids) {
			try {
				process.kill(pid, "SIGSTOP");
			} catch {}
			providerPausedSet.add(id);
		}
	}
	kanbanEmitter.emit("provider:paused", issueId);
});

kanbanEmitter.on("loop:resume-provider", (issueId?: string) => {
	if (issueId) {
		const pid = activeProviderPids.get(issueId);
		if (pid && providerPausedSet.has(issueId)) {
			try {
				process.kill(pid, "SIGCONT");
			} catch {}
			providerPausedSet.delete(issueId);
		}
	} else {
		// Resume ALL paused providers
		for (const id of providerPausedSet) {
			const pid = activeProviderPids.get(id);
			if (pid) {
				try {
					process.kill(pid, "SIGCONT");
				} catch {}
			}
		}
		providerPausedSet.clear();
	}
	kanbanEmitter.emit("provider:resumed", issueId);
});

function killProviderForIssue(issueId: string): void {
	const pid = activeProviderPids.get(issueId);
	if (!pid) return;
	if (providerPausedSet.has(issueId)) {
		try {
			process.kill(pid, "SIGCONT");
		} catch {}
		providerPausedSet.delete(issueId);
	}
	try {
		process.kill(pid, "SIGTERM");
	} catch {}
	setTimeout(() => {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}, 5000);
}

kanbanEmitter.on("loop:kill", (issueId?: string) => {
	if (issueId) {
		userKilledSet.add(issueId);
		killProviderForIssue(issueId);
	} else {
		// Kill first active provider (backward compat for single concurrency)
		const firstId = activeProviderPids.keys().next().value;
		if (firstId) {
			userKilledSet.add(firstId);
			killProviderForIssue(firstId);
		}
	}
});

kanbanEmitter.on("loop:skip", (issueId?: string) => {
	if (issueId) {
		userSkippedSet.add(issueId);
		killProviderForIssue(issueId);
	} else {
		const firstId = activeProviderPids.keys().next().value;
		if (firstId) {
			userSkippedSet.add(firstId);
			killProviderForIssue(firstId);
		}
	}
});

export interface LoopOptions {
	once: boolean;
	limit: number;
	dryRun: boolean;
	issueId?: string;
	concurrency: number;
}

function resolveModels(config: LisaConfig): ModelSpec[] {
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

interface LisaManifest {
	repoPath?: string;
	branch?: string;
	prUrl?: string;
}

function readLisaManifest(cwd: string, issueId?: string): LisaManifest | null {
	const manifestPath = getManifestPath(cwd, issueId);
	if (!existsSync(manifestPath)) return null;
	try {
		return JSON.parse(readFileSync(manifestPath, "utf-8").trim()) as LisaManifest;
	} catch {
		return null;
	}
}

function cleanupManifest(cwd: string, issueId?: string): void {
	try {
		unlinkSync(getManifestPath(cwd, issueId));
	} catch {}
}

function readManifestFile(filePath: string): LisaManifest | null {
	if (!existsSync(filePath)) return null;
	try {
		return JSON.parse(readFileSync(filePath, "utf-8").trim()) as LisaManifest;
	} catch {
		return null;
	}
}

function readPlanFile(filePath: string): ExecutionPlan | null {
	if (!existsSync(filePath)) return null;
	try {
		return JSON.parse(readFileSync(filePath, "utf-8").trim()) as ExecutionPlan;
	} catch {
		return null;
	}
}

function installSignalHandlers(): void {
	const cleanup = async (signal: string): Promise<void> => {
		if (shuttingDown) {
			logger.warn("Force exiting...");
			process.exit(1);
		}
		shuttingDown = true;
		stopSpinner();
		resetTitle();
		logger.warn(`Received ${signal}. Reverting active issues...`);

		// Kill all active provider processes
		for (const [, pid] of activeProviderPids) {
			try {
				process.kill(pid, "SIGTERM");
			} catch {}
		}

		// Revert all active issues
		const revertPromises = [...activeCleanups.entries()].map(
			async ([issueId, { previousStatus, source }]) => {
				try {
					await Promise.race([
						source.updateStatus(issueId, previousStatus),
						new Promise<never>((_, reject) =>
							setTimeout(() => reject(new Error("Revert timed out")), 5000),
						),
					]);
					logger.ok(`Reverted ${issueId} to "${previousStatus}"`);
				} catch (err) {
					logger.error(
						`Failed to revert ${issueId}: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
				kanbanEmitter.emit("issue:reverted", issueId);
			},
		);

		await Promise.allSettled(revertPromises);

		// Signal the TUI to exit cleanly (if running)
		const hasTUI = kanbanEmitter.listenerCount("tui:exit") > 0;
		kanbanEmitter.emit("tui:exit");
		if (hasTUI) {
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		process.exit(0);
	};

	process.on("SIGINT", () => {
		cleanup("SIGINT");
	});
	process.on("SIGTERM", () => {
		cleanup("SIGTERM");
	});
}

async function recoverOrphanIssues(source: Source, config: LisaConfig): Promise<void> {
	const orphanConfig = {
		...config.source_config,
		pick_from: config.source_config.in_progress,
	};

	while (true) {
		let orphan: Awaited<ReturnType<typeof source.fetchNextIssue>>;
		try {
			orphan = await source.fetchNextIssue(orphanConfig);
		} catch (err) {
			logger.warn(
				`Failed to check for orphan issues: ${err instanceof Error ? err.message : String(err)}`,
			);
			break;
		}

		if (!orphan) break;

		logger.warn(
			`Found orphan issue ${orphan.id} stuck in "${config.source_config.in_progress}". Reverting to "${config.source_config.pick_from}".`,
		);
		try {
			await source.updateStatus(orphan.id, config.source_config.pick_from);
			logger.ok(`Recovered orphan ${orphan.id}`);
		} catch (err) {
			logger.error(
				`Failed to recover orphan ${orphan.id}: ${err instanceof Error ? err.message : String(err)}`,
			);
			break;
		}
	}
}

export async function runLoop(config: LisaConfig, opts: LoopOptions): Promise<void> {
	const source = createSource(config.source);
	const models = resolveModels(config);
	const workspace = resolve(config.workspace);
	const concurrency = opts.concurrency;

	installSignalHandlers();

	// Prepare system cache directory and migrate legacy artifacts
	ensureCacheDir(workspace);
	migrateGuardrails(workspace);
	rotateLogFiles(workspace);

	logger.log(
		`Starting loop (models: ${models.map((m) => (m.model ? `${m.provider}/${m.model}` : m.provider)).join(" → ")}, source: ${config.source}, label: ${formatLabels(config.source_config)}, workflow: ${config.workflow}${concurrency > 1 ? `, concurrency: ${concurrency}` : ""})`,
	);

	// Recover orphan issues stuck in in_progress from previous interrupted runs
	if (!opts.dryRun) {
		await recoverOrphanIssues(source, config);
	}

	// Pre-populate kanban backlog when TUI is active
	if (kanbanEmitter.listenerCount("issue:queued") > 0) {
		try {
			const allIssues = await source.listIssues(config.source_config);
			for (const issue of allIssues) {
				kanbanEmitter.emit("issue:queued", issue);
			}
		} catch {
			// Non-fatal — kanban backlog starts empty
		}
	}

	if (concurrency <= 1) {
		// Sequential mode — original behavior
		await runSequentialLoop(config, source, models, workspace, opts);
	} else {
		// Concurrent pool mode
		await runConcurrentLoop(config, source, models, workspace, opts);
	}
}

// === Sequential loop (concurrency === 1) — preserves original behavior ===

async function runSequentialLoop(
	config: LisaConfig,
	source: Source,
	models: ModelSpec[],
	workspace: string,
	opts: LoopOptions,
): Promise<void> {
	let session = 0;
	const loopStart = Date.now();
	let completedCount = 0;

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
					`[dry-run] Would fetch issue from ${config.source} (${config.source_config.team}/${config.source_config.project})`,
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
		} catch (err) {
			stopSpinner();
			logger.error(`Failed to fetch issues: ${err instanceof Error ? err.message : String(err)}`);
			if (opts.once) break;
			setTitle("Lisa \u2014 cooling down...");
			await sleep(config.loop.cooldown * 1000);
			continue;
		}

		stopSpinner();

		if (!issue) {
			if (opts.issueId) {
				logger.error(`Issue '${opts.issueId}' not found.`);
			} else {
				logger.ok(`No more issues with label '${formatLabels(config.source_config)}'. Done.`);
				if (session === 1) {
					kanbanEmitter.emit("work:empty");
				}
			}
			break;
		}

		logger.ok(`Picked up: ${issue.id} — ${issue.title}`);
		setTitle(`Lisa \u2014 ${issue.id}`);

		// Validate minimum issue spec before accepting
		const specResult = validateIssueSpec(issue, config.validation);
		if (!specResult.valid) {
			logger.warn(`Skipping ${issue.id}: ${specResult.reason}`);
			const needsSpecLabel = "needs-spec";
			try {
				await source.addLabel?.(issue.id, needsSpecLabel);
				logger.ok(`Added label "${needsSpecLabel}" to ${issue.id}`);
			} catch (err) {
				logger.warn(
					`Failed to add label "${needsSpecLabel}": ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			const readyLabel = getRemoveLabel(config.source_config);
			if (readyLabel) {
				try {
					await source.removeLabel(issue.id, readyLabel);
					logger.ok(`Removed label "${readyLabel}" from ${issue.id}`);
				} catch (err) {
					logger.warn(
						`Failed to remove label "${readyLabel}": ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
			kanbanEmitter.emit("issue:skipped", issue.id);
			if (opts.once) break;
			continue;
		}

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
		try {
			const inProgress = config.source_config.in_progress;
			kanbanEmitter.emit("issue:started", issue.id);
			await source.updateStatus(issue.id, inProgress);
			logger.ok(`Moved ${issue.id} to "${inProgress}"`);
		} catch (err) {
			logger.warn(`Failed to update status: ${err instanceof Error ? err.message : String(err)}`);
		}

		// Register active issue for signal handler cleanup
		activeCleanups.set(issue.id, { previousStatus, source });

		let sessionResult: SessionResult;
		try {
			sessionResult =
				config.workflow === "worktree"
					? await runWorktreeSession(config, issue, logFile, session, models)
					: await runBranchSession(config, issue, logFile, session, models);
		} catch (err) {
			stopSpinner();
			logger.error(
				`Unhandled error in session for ${issue.id}: ${err instanceof Error ? err.message : String(err)}`,
			);
			try {
				await source.updateStatus(issue.id, previousStatus);
				logger.ok(`Reverted ${issue.id} to "${previousStatus}"`);
			} catch (revertErr) {
				logger.error(
					`Failed to revert status: ${revertErr instanceof Error ? revertErr.message : String(revertErr)}`,
				);
			}
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

		// Check for provider exhaustion
		if (
			!sessionResult.success &&
			!userKilledSet.has(issue.id) &&
			!userSkippedSet.has(issue.id) &&
			isCompleteProviderExhaustion(sessionResult.fallback.attempts)
		) {
			logger.error(
				"All providers exhausted due to infrastructure issues (quota, plan limits, or not installed). " +
					"Fix your provider configuration and restart lisa.",
			);
			break;
		}

		// Clean per-issue flags
		userKilledSet.delete(issue.id);
		userSkippedSet.delete(issue.id);
		providerPausedSet.delete(issue.id);

		if (!sessionResult.success) {
			logger.log(`Cooling down ${config.loop.cooldown}s before next issue...`);
			setTitle("Lisa \u2014 cooling down...");
			await sleep(config.loop.cooldown * 1000);
		} else if (!completed) {
			logger.log(`Cooling down ${config.loop.cooldown}s before next issue...`);
			setTitle("Lisa \u2014 cooling down...");
			await sleep(config.loop.cooldown * 1000);
		} else {
			logger.log(`Cooling down ${config.loop.cooldown}s before next issue...`);
			setTitle("Lisa \u2014 cooling down...");
			await sleep(config.loop.cooldown * 1000);
		}
	}

	if (completedCount > 0) {
		kanbanEmitter.emit("work:complete", {
			total: completedCount,
			duration: Date.now() - loopStart,
		});
	}
	resetTitle();
	logger.ok(`lisa finished. ${session} session(s) run.`);
}

// === Concurrent pool (concurrency > 1) ===

async function runConcurrentLoop(
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
	const activeWorkers = new Map<string, Promise<void>>();

	const processIssue = async (issue: Issue, session: number): Promise<void> => {
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-").substring(0, 19);
		const logFile = resolve(getLogsDir(workspace), `session_${session}_${timestamp}.log`);

		logger.ok(`Picked up: ${issue.id} — ${issue.title}`);

		// Validate minimum issue spec before accepting
		const specResult = validateIssueSpec(issue, config.validation);
		if (!specResult.valid) {
			logger.warn(`Skipping ${issue.id}: ${specResult.reason}`);
			const needsSpecLabel = "needs-spec";
			try {
				await source.addLabel?.(issue.id, needsSpecLabel);
				logger.ok(`Added label "${needsSpecLabel}" to ${issue.id}`);
			} catch (err) {
				logger.warn(
					`Failed to add label "${needsSpecLabel}": ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			const readyLabel = getRemoveLabel(config.source_config);
			if (readyLabel) {
				try {
					await source.removeLabel(issue.id, readyLabel);
					logger.ok(`Removed label "${readyLabel}" from ${issue.id}`);
				} catch (err) {
					logger.warn(
						`Failed to remove label "${readyLabel}": ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
			kanbanEmitter.emit("issue:skipped", issue.id);
			return;
		}

		kanbanEmitter.emit("issue:queued", issue);

		// Move issue to in-progress
		const previousStatus = config.source_config.pick_from;
		try {
			kanbanEmitter.emit("issue:started", issue.id);
			await source.updateStatus(issue.id, config.source_config.in_progress);
			logger.ok(`Moved ${issue.id} to "${config.source_config.in_progress}"`);
		} catch (err) {
			logger.warn(`Failed to update status: ${err instanceof Error ? err.message : String(err)}`);
		}

		activeCleanups.set(issue.id, { previousStatus, source });

		let sessionResult: SessionResult;
		try {
			sessionResult = await runWorktreeSession(config, issue, logFile, session, models);
		} catch (err) {
			logger.error(
				`Unhandled error in session for ${issue.id}: ${err instanceof Error ? err.message : String(err)}`,
			);
			try {
				await source.updateStatus(issue.id, previousStatus);
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
			} catch (err) {
				logger.error(`Failed to fetch issues: ${err instanceof Error ? err.message : String(err)}`);
				await sleep(config.loop.cooldown * 1000);
				sessionCounter--; // Don't count failed fetches
				break;
			}

			if (!issue) {
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

		if (activeWorkers.size === 0) break;

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
		kanbanEmitter.emit("work:complete", {
			total: completedCount,
			duration: Date.now() - loopStart,
		});
	}
	resetTitle();
	logger.ok(`lisa finished. ${sessionCounter} session(s) run, ${completedCount} completed.`);
}

// === Shared session result handler ===

async function handleSessionResult(
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
				await source.updateStatus(issue.id, previousStatus);
				logger.ok(`Reverted ${issue.id} to "${previousStatus}"`);
			} catch (err) {
				logger.error(
					`Failed to revert status: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			kanbanEmitter.emit("issue:killed", issue.id);
			activeCleanups.delete(issue.id);
			if (config.bell !== false) notify();
			return false;
		}

		if (userSkippedSet.has(issue.id)) {
			providerPausedSet.delete(issue.id);
			logger.warn(`Issue ${issue.id} skipped by user.`);
			try {
				await source.updateStatus(issue.id, previousStatus);
				logger.ok(`Reverted ${issue.id} to "${previousStatus}"`);
			} catch (err) {
				logger.error(
					`Failed to revert status: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			kanbanEmitter.emit("issue:skipped", issue.id);
			activeCleanups.delete(issue.id);
			if (config.bell !== false) notify();
			return false;
		}

		// All models failed
		logger.error(`All models failed for ${issue.id}. Reverting to "${previousStatus}".`);
		logAttemptHistory(sessionResult);
		try {
			await source.updateStatus(issue.id, previousStatus);
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
			await source.updateStatus(issue.id, previousStatus);
			logger.ok(`Reverted ${issue.id} to "${previousStatus}"`);
			kanbanEmitter.emit("issue:reverted", issue.id);
		} catch (err) {
			logger.error(`Failed to revert status: ${err instanceof Error ? err.message : String(err)}`);
		}
		activeCleanups.delete(issue.id);
		return false;
	}

	// Attach PR links
	for (const prUrl of sessionResult.prUrls) {
		try {
			await source.attachPullRequest(issue.id, prUrl);
			logger.ok(`Attached PR to ${issue.id}`);
		} catch (err) {
			logger.warn(`Failed to attach PR: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// Update issue status + remove label
	try {
		const doneStatus = config.source_config.done;
		const labelToRemove = opts.issueId ? undefined : getRemoveLabel(config.source_config);
		await source.completeIssue(issue.id, doneStatus, labelToRemove);
		logger.ok(`Updated ${issue.id} status to "${doneStatus}"`);
		for (const prUrl of sessionResult.prUrls) {
			kanbanEmitter.emit("issue:done", issue.id, prUrl);
		}
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

interface SessionResult {
	success: boolean;
	providerUsed: string;
	prUrls: string[];
	fallback: FallbackResult;
}

function logAttemptHistory(result: SessionResult): void {
	for (const [i, attempt] of result.fallback.attempts.entries()) {
		const status = attempt.success ? "OK" : "FAILED";
		const error = attempt.error ? ` — ${attempt.error}` : "";
		const duration = attempt.duration > 0 ? ` (${Math.round(attempt.duration / 1000)}s)` : "";
		logger.warn(`  Attempt ${i + 1}: ${attempt.provider} ${status}${error}${duration}`);
	}
}

function resolveBaseBranch(config: LisaConfig, repoPath: string): string {
	const workspace = resolve(config.workspace);
	const repo = config.repos.find((r) => resolve(workspace, r.path) === repoPath);
	return repo?.base_branch ?? config.base_branch;
}

async function findWorktreeForBranch(repoRoot: string, branch: string): Promise<string | null> {
	try {
		const { stdout } = await execa("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot });
		const lines = stdout.split("\n");
		let currentPath: string | null = null;
		for (const line of lines) {
			if (line.startsWith("worktree ")) {
				currentPath = line.slice("worktree ".length);
			}
			if (line.startsWith("branch ") && line.endsWith(`/${branch}`)) {
				return currentPath;
			}
		}
		return null;
	} catch {
		return null;
	}
}

async function runWorktreeSession(
	config: LisaConfig,
	issue: Issue,
	logFile: string,
	session: number,
	models: ModelSpec[],
): Promise<SessionResult> {
	// Multi-repo: delegate to planning + sequential sessions
	if (config.repos.length > 1) {
		return runWorktreeMultiRepoSession(config, issue, logFile, session, models);
	}

	const workspace = resolve(config.workspace);
	const repoPath = determineRepoPath(config.repos, issue, workspace) ?? workspace;
	const defaultBranch = resolveBaseBranch(config, repoPath);

	// Check if primary provider supports native worktree (e.g., Claude Code --worktree)
	const primaryProvider = createProvider(models[0]?.provider ?? "claude");
	const useNativeWorktree = primaryProvider.supportsNativeWorktree === true;

	if (useNativeWorktree) {
		return runNativeWorktreeSession(
			config,
			issue,
			logFile,
			session,
			models,
			repoPath,
			defaultBranch,
		);
	}

	return runManualWorktreeSession(config, issue, logFile, session, models, repoPath, defaultBranch);
}

async function runNativeWorktreeSession(
	config: LisaConfig,
	issue: Issue,
	logFile: string,
	session: number,
	models: ModelSpec[],
	repoPath: string,
	_defaultBranch: string,
): Promise<SessionResult> {
	const testRunner = detectTestRunner(repoPath);
	if (testRunner) logger.log(`Detected test runner: ${testRunner}`);
	const pm = detectPackageManager(repoPath);
	const projectContext = analyzeProject(repoPath);

	const workspace = resolve(config.workspace);

	// Clean stale manifest from previous run (per-issue)
	cleanupManifest(workspace, issue.id);

	const prompt = buildNativeWorktreePrompt(
		issue,
		repoPath,
		testRunner,
		pm,
		_defaultBranch,
		projectContext,
		getManifestPath(workspace, issue.id),
	);
	logger.initLogFile(logFile);
	startSpinner(`${issue.id} \u2014 implementing (native worktree)...`);
	logger.log(`Implementing with native worktree... (log: ${logFile})`);

	const result = await runWithFallback(models, prompt, {
		logFile,
		cwd: repoPath,
		guardrailsDir: workspace,
		issueId: issue.id,
		overseer: config.overseer,
		useNativeWorktree: true,
		onProcess: (pid) => {
			activeProviderPids.set(issue.id, pid);
		},
		shouldAbort: () => userKilledSet.has(issue.id) || userSkippedSet.has(issue.id),
	});
	stopSpinner();

	try {
		appendFileSync(
			logFile,
			`\n${"=".repeat(80)}\nProvider used: ${result.providerUsed}\nFull output:\n${result.output}\n`,
		);
	} catch {}

	if (!result.success) {
		logger.error(`Session ${session} failed for ${issue.id}. Check ${logFile}`);
		cleanupManifest(workspace, issue.id);
		return { success: false, providerUsed: result.providerUsed, prUrls: [], fallback: result };
	}

	const manifest = readLisaManifest(workspace, issue.id);
	cleanupManifest(workspace, issue.id);

	if (!manifest?.prUrl) {
		logger.error(`Agent did not produce a manifest with prUrl for ${issue.id}. Aborting.`);
		const worktreePath = manifest?.branch
			? await findWorktreeForBranch(repoPath, manifest.branch)
			: null;
		if (worktreePath) await cleanupWorktree(repoPath, worktreePath);
		return { success: false, providerUsed: result.providerUsed, prUrls: [], fallback: result };
	}

	const worktreePath = await findWorktreeForBranch(repoPath, manifest.branch ?? "");
	logger.ok(`PR created by provider: ${manifest.prUrl}`);
	await appendPrAttribution(manifest.prUrl, result.providerUsed);
	if (worktreePath) await cleanupWorktree(repoPath, worktreePath);

	logger.ok(`Session ${session} complete for ${issue.id}`);
	return {
		success: true,
		providerUsed: result.providerUsed,
		prUrls: [manifest.prUrl],
		fallback: result,
	};
}

async function runManualWorktreeSession(
	config: LisaConfig,
	issue: Issue,
	logFile: string,
	session: number,
	models: ModelSpec[],
	repoPath: string,
	defaultBranch: string,
): Promise<SessionResult> {
	const branchName = generateBranchName(issue.id, issue.title);

	// Use dependency branch as base when available (PR stacking)
	const baseBranch = issue.dependency?.branch ?? defaultBranch;

	startSpinner(`${issue.id} \u2014 creating worktree...`);
	logger.log(`Creating worktree for ${branchName} (base: ${baseBranch})...`);

	let worktreePath: string;
	try {
		worktreePath = await createWorktree(repoPath, branchName, baseBranch);
	} catch (err) {
		stopSpinner();
		logger.error(`Failed to create worktree: ${err instanceof Error ? err.message : String(err)}`);
		return {
			success: false,
			providerUsed: models[0]?.provider ?? "claude",
			prUrls: [],
			fallback: {
				success: false,
				output: "",
				duration: 0,
				providerUsed: models[0]?.provider ?? "claude",
				attempts: [],
			},
		};
	}

	stopSpinner();
	logger.ok(`Worktree created at ${worktreePath}`);

	// Detect test runner for prompt enhancement
	const testRunner = detectTestRunner(worktreePath);
	if (testRunner) {
		logger.log(`Detected test runner: ${testRunner}`);
	}
	const pm = detectPackageManager(worktreePath);
	const projectContext = analyzeProject(worktreePath);

	const workspace = resolve(config.workspace);
	// Manifest written within the worktree so all providers (Gemini, OpenCode, etc.) can access it
	const manifestPath = join(worktreePath, ".lisa-manifest.json");
	const prompt = buildImplementPrompt(
		issue,
		config,
		testRunner,
		pm,
		projectContext,
		worktreePath,
		manifestPath,
	);
	logger.initLogFile(logFile);
	startSpinner(`${issue.id} \u2014 implementing...`);
	logger.log(`Implementing in worktree... (log: ${logFile})`);

	const result = await runWithFallback(models, prompt, {
		logFile,
		cwd: worktreePath,
		guardrailsDir: workspace,
		issueId: issue.id,
		overseer: config.overseer,
		onProcess: (pid) => {
			activeProviderPids.set(issue.id, pid);
		},
		shouldAbort: () => userKilledSet.has(issue.id) || userSkippedSet.has(issue.id),
	});
	stopSpinner();

	try {
		appendFileSync(
			logFile,
			`\n${"=".repeat(80)}\nProvider used: ${result.providerUsed}\nFull output:\n${result.output}\n`,
		);
	} catch {
		// Ignore log write errors
	}

	if (!result.success) {
		logger.error(`Session ${session} failed for ${issue.id}. Check ${logFile}`);
		await cleanupWorktree(repoPath, worktreePath);
		return { success: false, providerUsed: result.providerUsed, prUrls: [], fallback: result };
	}

	// Read manifest from worktree (accessible by all providers; worktree cleanup removes it)
	const manifest = readManifestFile(manifestPath);

	if (!manifest?.prUrl) {
		logger.error(`Agent did not produce a manifest with prUrl for ${issue.id}. Aborting.`);
		await cleanupWorktree(repoPath, worktreePath);
		return { success: false, providerUsed: result.providerUsed, prUrls: [], fallback: result };
	}

	logger.ok(`PR created by provider: ${manifest.prUrl}`);
	await appendPrAttribution(manifest.prUrl, result.providerUsed);
	await cleanupWorktree(repoPath, worktreePath);

	logger.ok(`Session ${session} complete for ${issue.id}`);
	return {
		success: true,
		providerUsed: result.providerUsed,
		prUrls: [manifest.prUrl],
		fallback: result,
	};
}

async function runWorktreeMultiRepoSession(
	config: LisaConfig,
	issue: Issue,
	logFile: string,
	session: number,
	models: ModelSpec[],
): Promise<SessionResult> {
	const workspace = resolve(config.workspace);
	// Plan written within the workspace so all providers can access it; per-issue name avoids
	// collisions when multiple issues run concurrently in worktree mode
	const safeId = issue.id.replace(/[^a-zA-Z0-9_-]/g, "_");
	const planPath = join(workspace, `.lisa-plan-${safeId}.json`);

	// Clean stale plan from a previous interrupted run
	try {
		unlinkSync(planPath);
	} catch {}

	// Phase 1: Planning — agent analyzes issue and produces execution plan
	logger.initLogFile(logFile);
	startSpinner(`${issue.id} \u2014 analyzing issue...`);
	logger.log(`Multi-repo planning phase for ${issue.id}`);

	const planPrompt = buildPlanningPrompt(issue, config, planPath);
	const planResult = await runWithFallback(models, planPrompt, {
		logFile,
		cwd: workspace,
		guardrailsDir: workspace,
		issueId: issue.id,
		overseer: config.overseer,
		onProcess: (pid) => {
			activeProviderPids.set(issue.id, pid);
		},
		shouldAbort: () => userKilledSet.has(issue.id) || userSkippedSet.has(issue.id),
	});
	stopSpinner();

	try {
		appendFileSync(
			logFile,
			`\n${"=".repeat(80)}\nPlanning phase — provider: ${planResult.providerUsed}\n${planResult.output}\n`,
		);
	} catch {}

	if (!planResult.success) {
		logger.error(`Planning phase failed for ${issue.id}. Check ${logFile}`);
		try {
			unlinkSync(planPath);
		} catch {}
		activeProviderPids.delete(issue.id);
		return {
			success: false,
			providerUsed: planResult.providerUsed,
			prUrls: [],
			fallback: planResult,
		};
	}

	// Read execution plan from within the workspace (accessible to all providers)
	const plan = readPlanFile(planPath);
	if (!plan?.steps || plan.steps.length === 0) {
		logger.error(`Agent did not produce a valid execution plan for ${issue.id}. Aborting.`);
		try {
			unlinkSync(planPath);
		} catch {}
		activeProviderPids.delete(issue.id);
		return {
			success: false,
			providerUsed: planResult.providerUsed,
			prUrls: [],
			fallback: planResult,
		};
	}

	// Sort steps by order
	const sortedSteps = [...plan.steps].sort((a, b) => a.order - b.order);
	logger.ok(
		`Plan produced ${sortedSteps.length} step(s): ${sortedSteps.map((s) => s.repoPath).join(" → ")}`,
	);
	try {
		unlinkSync(planPath);
	} catch {}

	// Phase 2: Sequential implementation — one session per repo step
	const prUrls: string[] = [];
	const previousResults: PreviousStepResult[] = [];
	let lastFallback: FallbackResult = planResult;
	let lastProvider: string = planResult.providerUsed;

	for (const [i, step] of sortedSteps.entries()) {
		const stepNum = i + 1;
		const isLastStep = i === sortedSteps.length - 1;
		logger.divider(stepNum);
		logger.log(`Step ${stepNum}/${sortedSteps.length}: ${step.repoPath} — ${step.scope}`);

		const stepResult = await runMultiRepoStep(
			config,
			issue,
			step,
			previousResults,
			logFile,
			models,
			stepNum,
			isLastStep,
		);

		lastFallback = stepResult.fallback;
		lastProvider = stepResult.providerUsed;

		if (!stepResult.success) {
			logger.error(`Step ${stepNum} failed for ${step.repoPath}. Aborting remaining steps.`);
			activeProviderPids.delete(issue.id);
			return {
				success: false,
				providerUsed: lastProvider,
				prUrls,
				fallback: lastFallback,
			};
		}

		if (stepResult.prUrl) {
			prUrls.push(stepResult.prUrl);
		}

		previousResults.push({
			repoPath: step.repoPath,
			branch: stepResult.branch,
			prUrl: stepResult.prUrl,
		});
	}

	activeProviderPids.delete(issue.id);
	logger.ok(`Session ${session} complete for ${issue.id} — ${prUrls.length} PR(s) created`);
	return { success: true, providerUsed: lastProvider, prUrls, fallback: lastFallback };
}

interface MultiRepoStepResult {
	success: boolean;
	providerUsed: string;
	branch: string;
	prUrl?: string;
	fallback: FallbackResult;
}

async function runMultiRepoStep(
	config: LisaConfig,
	issue: Issue,
	step: PlanStep,
	previousResults: PreviousStepResult[],
	logFile: string,
	models: ModelSpec[],
	stepNum: number,
	isLastStep: boolean,
): Promise<MultiRepoStepResult> {
	const repoPath = step.repoPath;
	const defaultBranch = resolveBaseBranch(config, repoPath);
	const branchName = generateBranchName(issue.id, issue.title);

	// Use dependency branch as base when available (PR stacking)
	const baseBranch = issue.dependency?.branch ?? defaultBranch;

	const failResult = (providerUsed: string, fallback?: FallbackResult): MultiRepoStepResult => ({
		success: false,
		providerUsed,
		branch: branchName,
		fallback: fallback ?? { success: false, output: "", duration: 0, providerUsed, attempts: [] },
	});

	// Create worktree for this step
	startSpinner(`${issue.id} step ${stepNum} \u2014 creating worktree...`);
	let worktreePath: string;
	try {
		worktreePath = await createWorktree(repoPath, branchName, baseBranch);
	} catch (err) {
		stopSpinner();
		logger.error(`Failed to create worktree: ${err instanceof Error ? err.message : String(err)}`);
		return failResult(models[0]?.provider ?? "claude");
	}
	stopSpinner();
	logger.ok(`Worktree created at ${worktreePath}`);

	// Detect test runner and package manager
	const testRunner = detectTestRunner(worktreePath);
	if (testRunner) logger.log(`Detected test runner: ${testRunner}`);
	const pm = detectPackageManager(worktreePath);
	const projectContext = analyzeProject(worktreePath);

	// Run scoped implementation
	const workspace = resolve(config.workspace);
	// Manifest written within the worktree so all providers can access it
	const manifestPath = join(worktreePath, ".lisa-manifest.json");
	const prompt = buildScopedImplementPrompt(
		issue,
		step,
		previousResults,
		testRunner,
		pm,
		isLastStep,
		defaultBranch,
		projectContext,
		manifestPath,
		worktreePath,
	);
	startSpinner(`${issue.id} step ${stepNum} \u2014 implementing...`);

	const result = await runWithFallback(models, prompt, {
		logFile,
		cwd: worktreePath,
		guardrailsDir: workspace,
		issueId: issue.id,
		overseer: config.overseer,
		onProcess: (pid) => {
			activeProviderPids.set(issue.id, pid);
		},
		shouldAbort: () => userKilledSet.has(issue.id) || userSkippedSet.has(issue.id),
	});
	stopSpinner();

	try {
		appendFileSync(
			logFile,
			`\n${"=".repeat(80)}\nStep ${stepNum} — provider: ${result.providerUsed}\n${result.output}\n`,
		);
	} catch {}

	if (!result.success) {
		logger.error(`Step ${stepNum} implementation failed. Check ${logFile}`);
		await cleanupWorktree(repoPath, worktreePath);
		return { ...failResult(result.providerUsed, result), branch: branchName };
	}

	// Read manifest from worktree (accessible to all providers; worktree cleanup removes it)
	const manifest = readManifestFile(manifestPath);

	if (!manifest?.prUrl) {
		logger.error(`Agent did not produce a manifest with prUrl for step ${stepNum}.`);
		await cleanupWorktree(repoPath, worktreePath);
		return { ...failResult(result.providerUsed, result), branch: branchName };
	}

	await cleanupWorktree(repoPath, worktreePath);
	await appendPrAttribution(manifest.prUrl, result.providerUsed);

	logger.ok(`Step ${stepNum} complete: ${repoPath} — PR: ${manifest.prUrl}`);
	return {
		success: true,
		providerUsed: result.providerUsed,
		branch: manifest.branch ?? branchName,
		prUrl: manifest.prUrl,
		fallback: result,
	};
}

async function runBranchSession(
	config: LisaConfig,
	issue: Issue,
	logFile: string,
	session: number,
	models: ModelSpec[],
): Promise<SessionResult> {
	const workspace = resolve(config.workspace);
	// Manifest written within the workspace so all providers can access it (branch mode is sequential)
	const manifestPath = join(workspace, ".lisa-manifest.json");

	// Clean any stale manifest from a previous interrupted run
	try {
		unlinkSync(manifestPath);
	} catch {}

	// Detect test runner for prompt enhancement
	const testRunner = detectTestRunner(workspace);
	if (testRunner) {
		logger.log(`Detected test runner: ${testRunner}`);
	}
	const pm = detectPackageManager(workspace);
	const projectContext = analyzeProject(workspace);

	const prompt = buildImplementPrompt(
		issue,
		config,
		testRunner,
		pm,
		projectContext,
		workspace,
		manifestPath,
	);

	logger.initLogFile(logFile);
	startSpinner(`${issue.id} \u2014 implementing...`);
	logger.log(`Implementing... (log: ${logFile})`);

	const result = await runWithFallback(models, prompt, {
		logFile,
		cwd: workspace,
		guardrailsDir: workspace,
		issueId: issue.id,
		overseer: config.overseer,
		onProcess: (pid) => {
			activeProviderPids.set(issue.id, pid);
		},
		shouldAbort: () => userKilledSet.has(issue.id) || userSkippedSet.has(issue.id),
	});
	stopSpinner();

	try {
		appendFileSync(
			logFile,
			`\n${"=".repeat(80)}\nProvider used: ${result.providerUsed}\nFull output:\n${result.output}\n`,
		);
	} catch {
		// Ignore log write errors
	}

	if (!result.success) {
		logger.error(`Session ${session} failed for ${issue.id}. Check ${logFile}`);
		return { success: false, providerUsed: result.providerUsed, prUrls: [], fallback: result };
	}

	const manifest = readManifestFile(manifestPath);
	try {
		unlinkSync(manifestPath);
	} catch {}

	if (!manifest?.prUrl) {
		logger.error(`Agent did not produce a manifest with prUrl for ${issue.id}.`);
		return { success: false, providerUsed: result.providerUsed, prUrls: [], fallback: result };
	}

	logger.ok(`PR created by provider: ${manifest.prUrl}`);
	await appendPrAttribution(manifest.prUrl, result.providerUsed);
	logger.ok(`Session ${session} complete for ${issue.id}`);
	return {
		success: true,
		providerUsed: result.providerUsed,
		prUrls: [manifest.prUrl],
		fallback: result,
	};
}

async function cleanupWorktree(repoRoot: string, worktreePath: string): Promise<void> {
	try {
		await removeWorktree(repoRoot, worktreePath);
		logger.log("Worktree cleaned up.");
	} catch (err) {
		logger.warn(`Failed to clean up worktree: ${err instanceof Error ? err.message : String(err)}`);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitIfPaused(): Promise<void> {
	while (loopPaused) {
		await sleep(500);
	}
}
