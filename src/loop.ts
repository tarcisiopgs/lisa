import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPullRequest, getRepoInfo } from "./github.js";
import { startResources, stopResources } from "./lifecycle.js";
import * as logger from "./logger.js";
import { buildImplementPrompt } from "./prompt.js";
import { runWithFallback } from "./providers/index.js";
import { createSource } from "./sources/index.js";
import type { FallbackResult, LisaConfig, ProviderName, RepoConfig, Source } from "./types.js";
import {
	createWorktree,
	detectFeatureBranches,
	determineRepoPath,
	generateBranchName,
	removeWorktree,
} from "./worktree.js";

// === Module-level state for signal handler cleanup ===
let activeCleanup: { issueId: string; previousStatus: string; source: Source } | null = null;
let shuttingDown = false;

export interface LoopOptions {
	once: boolean;
	limit: number;
	dryRun: boolean;
	issueId?: string;
}

function resolveModels(config: LisaConfig): ProviderName[] {
	if (config.models && config.models.length > 0) return config.models;
	return [config.provider];
}

function buildPrBody(issue: { url: string }, providerUsed: ProviderName): string {
	return `Closes ${issue.url}\n\nImplemented by [lisa](https://github.com/tarcisiopgs/lisa) using **${providerUsed}**.`;
}

function installSignalHandlers(): void {
	const cleanup = async (signal: string): Promise<void> => {
		if (shuttingDown) {
			logger.warn("Force exiting...");
			process.exit(1);
		}
		shuttingDown = true;
		logger.warn(`Received ${signal}. Reverting active issue...`);

		if (activeCleanup) {
			const { issueId, previousStatus, source } = activeCleanup;
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
		}

		process.exit(1);
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

	installSignalHandlers();

	logger.log(
		`Starting loop (models: ${models.join(" → ")}, source: ${config.source}, label: ${config.source_config.label}, workflow: ${config.workflow})`,
	);

	// Recover orphan issues stuck in in_progress from previous interrupted runs
	if (!opts.dryRun) {
		await recoverOrphanIssues(source, config);
	}

	let session = 0;

	while (true) {
		session++;

		if (opts.limit > 0 && session > opts.limit) {
			logger.ok(`Reached limit of ${opts.limit} issues. Stopping.`);
			break;
		}

		const timestamp = new Date().toISOString().replace(/[:.]/g, "-").substring(0, 19);
		const logFile = resolve(config.logs.dir, `session_${session}_${timestamp}.log`);

		logger.divider(session);

		// 1. Fetch issue — either by ID or from queue
		if (opts.issueId) {
			logger.log(`Fetching issue '${opts.issueId}' from ${config.source}...`);
		} else {
			logger.log(`Fetching next '${config.source_config.label}' issue from ${config.source}...`);
		}

		if (opts.dryRun) {
			if (opts.issueId) {
				logger.log(`[dry-run] Would fetch issue '${opts.issueId}' from ${config.source}`);
			} else {
				logger.log(
					`[dry-run] Would fetch issue from ${config.source} (${config.source_config.team}/${config.source_config.project})`,
				);
			}
			logger.log(`[dry-run] Workflow mode: ${config.workflow}`);
			logger.log(`[dry-run] Models priority: ${models.join(" → ")}`);
			logger.log("[dry-run] Then implement, push, create PR, and update issue status");
			break;
		}

		let issue: Awaited<ReturnType<typeof source.fetchNextIssue>>;
		try {
			issue = opts.issueId
				? await source.fetchIssueById(opts.issueId)
				: await source.fetchNextIssue(config.source_config);
		} catch (err) {
			logger.error(`Failed to fetch issues: ${err instanceof Error ? err.message : String(err)}`);
			if (opts.once) break;
			await sleep(config.loop.cooldown * 1000);
			continue;
		}

		if (!issue) {
			if (opts.issueId) {
				logger.error(`Issue '${opts.issueId}' not found.`);
			} else {
				logger.ok(`No more issues with label '${config.source_config.label}'. Done.`);
			}
			break;
		}

		logger.ok(`Picked up: ${issue.id} — ${issue.title}`);

		// Move issue to in-progress status before starting work
		const previousStatus = config.source_config.pick_from;
		try {
			const inProgress = config.source_config.in_progress;
			await source.updateStatus(issue.id, inProgress);
			logger.ok(`Moved ${issue.id} to "${inProgress}"`);
		} catch (err) {
			logger.warn(`Failed to update status: ${err instanceof Error ? err.message : String(err)}`);
		}

		// Register active issue for signal handler cleanup
		activeCleanup = { issueId: issue.id, previousStatus, source };

		let sessionResult: SessionResult;
		try {
			sessionResult =
				config.workflow === "worktree"
					? await runWorktreeSession(config, issue, logFile, session, models)
					: await runBranchSession(config, issue, logFile, session, models);
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
			activeCleanup = null;
			if (opts.once) break;
			logger.log(`Cooling down ${config.loop.cooldown}s before next issue...`);
			await sleep(config.loop.cooldown * 1000);
			continue;
		}

		if (!sessionResult.success) {
			// All models failed — revert issue to previous status
			logger.error(`All models failed for ${issue.id}. Reverting to "${previousStatus}".`);
			logAttemptHistory(sessionResult);
			try {
				await source.updateStatus(issue.id, previousStatus);
				logger.ok(`Reverted ${issue.id} to "${previousStatus}"`);
			} catch (err) {
				logger.error(
					`Failed to revert status: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			activeCleanup = null;

			if (opts.once) {
				logger.log("Single iteration mode. Exiting.");
				break;
			}
			logger.log(`Cooling down ${config.loop.cooldown}s before next issue...`);
			await sleep(config.loop.cooldown * 1000);
			continue;
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
			} catch (err) {
				logger.error(
					`Failed to revert status: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			activeCleanup = null;

			if (opts.once) {
				logger.log("Single iteration mode. Exiting.");
				break;
			}
			logger.log(`Cooling down ${config.loop.cooldown}s before next issue...`);
			await sleep(config.loop.cooldown * 1000);
			continue;
		}

		// Attach PR links to issue card
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
			await source.updateStatus(issue.id, doneStatus);
			logger.ok(`Updated ${issue.id} status to "${doneStatus}"`);
		} catch (err) {
			logger.error(`Failed to update status: ${err instanceof Error ? err.message : String(err)}`);
		}

		if (!opts.issueId) {
			try {
				await source.removeLabel(issue.id, config.source_config.label);
				logger.ok(`Removed label "${config.source_config.label}" from ${issue.id}`);
			} catch (err) {
				logger.error(`Failed to remove label: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		activeCleanup = null;

		if (opts.once) {
			logger.log("Single iteration mode. Exiting.");
			break;
		}

		logger.log(`Cooling down ${config.loop.cooldown}s before next issue...`);
		await sleep(config.loop.cooldown * 1000);
	}

	logger.ok(`lisa finished. ${session} session(s) run.`);
}

interface SessionResult {
	success: boolean;
	providerUsed: ProviderName;
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

function findRepoConfig(
	config: LisaConfig,
	issue: { repo?: string; title: string },
): RepoConfig | undefined {
	if (config.repos.length === 0) return undefined;

	if (issue.repo) {
		const match = config.repos.find((r) => r.name === issue.repo);
		if (match) return match;
	}

	for (const r of config.repos) {
		if (r.match && issue.title.startsWith(r.match)) return r;
	}

	return config.repos[0];
}

async function runWorktreeSession(
	config: LisaConfig,
	issue: { id: string; title: string; url: string; description: string; repo?: string },
	logFile: string,
	session: number,
	models: ProviderName[],
): Promise<SessionResult> {
	const workspace = resolve(config.workspace);

	// Determine target repo root
	const repoPath = determineRepoPath(config.repos, issue, workspace) ?? workspace;

	const defaultBranch = resolveBaseBranch(config, repoPath);
	const branchName = generateBranchName(issue.id, issue.title);

	logger.log(`Creating worktree for ${branchName} (base: ${defaultBranch})...`);

	let worktreePath: string;
	try {
		worktreePath = await createWorktree(repoPath, branchName, defaultBranch);
	} catch (err) {
		logger.error(`Failed to create worktree: ${err instanceof Error ? err.message : String(err)}`);
		return {
			success: false,
			providerUsed: models[0]!,
			prUrls: [],
			fallback: { success: false, output: "", duration: 0, providerUsed: models[0]!, attempts: [] },
		};
	}

	logger.ok(`Worktree created at ${worktreePath}`);

	// Start lifecycle resources before implementation
	const repo = findRepoConfig(config, issue);
	if (repo?.lifecycle) {
		const started = await startResources(repo, worktreePath);
		if (!started) {
			logger.error(`Lifecycle startup failed for ${issue.id}. Aborting session.`);
			await cleanupWorktree(repoPath, worktreePath);
			return {
				success: false,
				providerUsed: models[0]!,
				prUrls: [],
				fallback: {
					success: false,
					output: "",
					duration: 0,
					providerUsed: models[0]!,
					attempts: [],
				},
			};
		}
	}

	const prompt = buildImplementPrompt(issue, config);
	logger.log(`Implementing in worktree... (log: ${logFile})`);
	logger.initLogFile(logFile);

	const result = await runWithFallback(models, prompt, { logFile, cwd: worktreePath });

	try {
		appendFileSync(
			logFile,
			`\n${"=".repeat(80)}\nProvider used: ${result.providerUsed}\nFull output:\n${result.output}\n`,
		);
	} catch {
		// Ignore log write errors
	}

	// Stop lifecycle resources after implementation
	if (repo?.lifecycle) {
		await stopResources();
	}

	if (!result.success) {
		logger.error(`Session ${session} failed for ${issue.id}. Check ${logFile}`);
		await cleanupWorktree(repoPath, worktreePath);
		return { success: false, providerUsed: result.providerUsed, prUrls: [], fallback: result };
	}

	// Create PR from worktree
	const prUrls: string[] = [];
	try {
		const repoInfo = await getRepoInfo(worktreePath);
		const pr = await createPullRequest(
			{
				owner: repoInfo.owner,
				repo: repoInfo.repo,
				head: branchName,
				base: defaultBranch,
				title: issue.title,
				body: buildPrBody(issue, result.providerUsed),
			},
			config.github,
		);
		logger.ok(`PR created: ${pr.html_url}`);
		prUrls.push(pr.html_url);
	} catch (err) {
		logger.error(`Failed to create PR: ${err instanceof Error ? err.message : String(err)}`);
	}

	await cleanupWorktree(repoPath, worktreePath);

	logger.ok(`Session ${session} complete for ${issue.id}`);
	return { success: true, providerUsed: result.providerUsed, prUrls, fallback: result };
}

async function runBranchSession(
	config: LisaConfig,
	issue: { id: string; title: string; url: string; description: string; repo?: string },
	logFile: string,
	session: number,
	models: ProviderName[],
): Promise<SessionResult> {
	const prompt = buildImplementPrompt(issue, config);
	const workspace = resolve(config.workspace);

	// Start lifecycle resources before implementation
	const repo = findRepoConfig(config, issue);
	if (repo?.lifecycle) {
		const cwd = resolve(workspace, repo.path);
		const started = await startResources(repo, cwd);
		if (!started) {
			logger.error(`Lifecycle startup failed for ${issue.id}. Aborting session.`);
			return {
				success: false,
				providerUsed: models[0]!,
				prUrls: [],
				fallback: {
					success: false,
					output: "",
					duration: 0,
					providerUsed: models[0]!,
					attempts: [],
				},
			};
		}
	}

	logger.log(`Implementing... (log: ${logFile})`);
	logger.initLogFile(logFile);

	const result = await runWithFallback(models, prompt, { logFile, cwd: workspace });

	try {
		appendFileSync(
			logFile,
			`\n${"=".repeat(80)}\nProvider used: ${result.providerUsed}\nFull output:\n${result.output}\n`,
		);
	} catch {
		// Ignore log write errors
	}

	// Stop lifecycle resources after implementation
	if (repo?.lifecycle) {
		await stopResources();
	}

	if (!result.success) {
		logger.error(`Session ${session} failed for ${issue.id}. Check ${logFile}`);
		return { success: false, providerUsed: result.providerUsed, prUrls: [], fallback: result };
	}

	// Scan all repos to find where feature branches were created (may span multiple repos)
	const detected = await detectFeatureBranches(
		config.repos,
		issue.id,
		workspace,
		config.base_branch,
	);

	if (detected.length === 0) {
		logger.error(`Could not detect feature branch for ${issue.id} — skipping PR creation`);
		logger.ok(`Session ${session} complete for ${issue.id}`);
		return { success: true, providerUsed: result.providerUsed, prUrls: [], fallback: result };
	}

	const prUrls: string[] = [];
	for (const { repoPath, branch } of detected) {
		const baseBranch = resolveBaseBranch(config, repoPath);
		if (branch === baseBranch) continue;

		try {
			const repoInfo = await getRepoInfo(repoPath);
			const pr = await createPullRequest(
				{
					owner: repoInfo.owner,
					repo: repoInfo.repo,
					head: branch,
					base: baseBranch,
					title: issue.title,
					body: buildPrBody(issue, result.providerUsed),
				},
				config.github,
			);
			logger.ok(`PR created: ${pr.html_url}`);
			prUrls.push(pr.html_url);
		} catch (err) {
			logger.error(`Failed to create PR: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	logger.ok(`Session ${session} complete for ${issue.id}`);
	return { success: true, providerUsed: result.providerUsed, prUrls, fallback: result };
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
