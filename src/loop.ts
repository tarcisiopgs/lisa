import { appendFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { execa } from "execa";
import { createPullRequest, getRepoInfo } from "./github.js";
import { startResources, stopResources } from "./lifecycle.js";
import * as logger from "./logger.js";
import {
	buildImplementPrompt,
	buildPushRecoveryPrompt,
	buildWorktreeMultiRepoPrompt,
	detectTestRunner,
} from "./prompt.js";
import { runWithFallback } from "./providers/index.js";
import { createSource } from "./sources/index.js";
import { notify, resetTitle, setTitle, startSpinner, stopSpinner } from "./terminal.js";
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

const PR_TITLE_FILE = ".pr-title";

function readPrTitle(cwd: string): string | null {
	try {
		const title = readFileSync(join(cwd, PR_TITLE_FILE), "utf-8").trim().split("\n")[0]?.trim();
		return title || null;
	} catch {
		return null;
	}
}

function cleanupPrTitle(cwd: string): void {
	try {
		unlinkSync(join(cwd, PR_TITLE_FILE));
	} catch {
		// File may not exist — ignore
	}
}

const MANIFEST_FILE = ".lisa-manifest.json";

interface LisaManifest {
	repoPath?: string;
	branch?: string;
	prTitle?: string;
}

function readLisaManifest(dir: string): LisaManifest | null {
	const manifestPath = join(dir, MANIFEST_FILE);
	if (!existsSync(manifestPath)) return null;
	try {
		return JSON.parse(readFileSync(manifestPath, "utf-8").trim()) as LisaManifest;
	} catch {
		return null;
	}
}

function cleanupManifest(dir: string): void {
	try {
		unlinkSync(join(dir, MANIFEST_FILE));
	} catch {
		// File may not exist — ignore
	}
}

const MAX_PUSH_RETRIES = 2;

const HOOK_ERROR_PATTERNS = [
	/husky - pre-push/i,
	/husky - pre-commit/i,
	/pre-push hook/i,
	/pre-commit hook/i,
	/hook declined/i,
	/hook.*failed/i,
	/hook.*exited with/i,
	/hook.*returned.*exit code/i,
];

function isHookError(errorMessage: string): boolean {
	return HOOK_ERROR_PATTERNS.some((pattern) => pattern.test(errorMessage));
}

interface PushRecoveryOptions {
	branch: string;
	cwd: string;
	models: ProviderName[];
	logFile: string;
	guardrailsDir: string;
	issueId: string;
	overseer?: import("./types.js").OverseerConfig;
}

async function pushWithRecovery(
	opts: PushRecoveryOptions,
): Promise<{ success: boolean; error?: string }> {
	for (let attempt = 0; attempt <= MAX_PUSH_RETRIES; attempt++) {
		try {
			await execa("git", ["push", "-u", "origin", opts.branch], { cwd: opts.cwd });
			return { success: true };
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err);

			if (!isHookError(errorMessage)) {
				return { success: false, error: errorMessage };
			}

			if (attempt >= MAX_PUSH_RETRIES) {
				return {
					success: false,
					error: `Push hook failed after ${MAX_PUSH_RETRIES} recovery attempts: ${errorMessage}`,
				};
			}

			logger.warn(
				`Push hook failed (attempt ${attempt + 1}/${MAX_PUSH_RETRIES}). Re-invoking provider to fix...`,
			);

			const recoveryPrompt = buildPushRecoveryPrompt(errorMessage);
			const result = await runWithFallback(opts.models, recoveryPrompt, {
				logFile: opts.logFile,
				cwd: opts.cwd,
				guardrailsDir: opts.guardrailsDir,
				issueId: opts.issueId,
				overseer: opts.overseer,
			});

			if (!result.success) {
				return {
					success: false,
					error: `Provider failed to fix push hook errors: ${result.output}`,
				};
			}

			logger.ok("Provider finished recovery. Retrying push...");
		}
	}

	return { success: false, error: "Push recovery exhausted retries" };
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
		startSpinner("fetching issue...");
		if (opts.issueId) {
			logger.log(`Fetching issue '${opts.issueId}' from ${config.source}...`);
		} else {
			logger.log(`Fetching next '${config.source_config.label}' issue from ${config.source}...`);
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
				logger.ok(`No more issues with label '${config.source_config.label}'. Done.`);
			}
			break;
		}

		logger.ok(`Picked up: ${issue.id} — ${issue.title}`);
		setTitle(`Lisa \u2014 ${issue.id}`);

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
			activeCleanup = null;
			notify();
			if (opts.once) break;
			logger.log(`Cooling down ${config.loop.cooldown}s before next issue...`);
			setTitle("Lisa \u2014 cooling down...");
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
			notify();

			if (opts.once) {
				logger.log("Single iteration mode. Exiting.");
				break;
			}
			logger.log(`Cooling down ${config.loop.cooldown}s before next issue...`);
			setTitle("Lisa \u2014 cooling down...");
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
			notify();

			if (opts.once) {
				logger.log("Single iteration mode. Exiting.");
				break;
			}
			logger.log(`Cooling down ${config.loop.cooldown}s before next issue...`);
			setTitle("Lisa \u2014 cooling down...");
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

		// Update issue status + remove label atomically (single API call for Linear)
		try {
			const doneStatus = config.source_config.done;
			const labelToRemove = opts.issueId ? undefined : config.source_config.label;
			await source.completeIssue(issue.id, doneStatus, labelToRemove);
			logger.ok(`Updated ${issue.id} status to "${doneStatus}"`);
			if (labelToRemove) {
				logger.ok(`Removed label "${labelToRemove}" from ${issue.id}`);
			}
		} catch (err) {
			logger.error(`Failed to complete issue: ${err instanceof Error ? err.message : String(err)}`);
		}

		activeCleanup = null;
		stopSpinner(`\u2713 Lisa \u2014 ${issue.id} \u2014 PR created`);
		notify();

		if (opts.once) {
			logger.log("Single iteration mode. Exiting.");
			break;
		}

		logger.log(`Cooling down ${config.loop.cooldown}s before next issue...`);
		setTitle("Lisa \u2014 cooling down...");
		await sleep(config.loop.cooldown * 1000);
	}

	resetTitle();
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

async function runTestValidation(cwd: string): Promise<boolean> {
	const testRunner = detectTestRunner(cwd);
	if (!testRunner) return true;

	logger.log(`Running test validation (${testRunner} detected)...`);
	try {
		await execa("npm", ["run", "test"], { cwd, stdio: "pipe" });
		logger.ok("Tests passed.");
		return true;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logger.error(`Tests failed: ${message}`);
		return false;
	}
}

async function runWorktreeSession(
	config: LisaConfig,
	issue: { id: string; title: string; url: string; description: string; repo?: string },
	logFile: string,
	session: number,
	models: ProviderName[],
): Promise<SessionResult> {
	// Multi-repo: delegate repo selection and worktree creation to the provider
	if (config.repos.length > 1) {
		return runWorktreeMultiRepoSession(config, issue, logFile, session, models);
	}

	const workspace = resolve(config.workspace);

	// Determine target repo root
	const repoPath = determineRepoPath(config.repos, issue, workspace) ?? workspace;

	const defaultBranch = resolveBaseBranch(config, repoPath);
	const branchName = generateBranchName(issue.id, issue.title);

	startSpinner(`${issue.id} \u2014 creating worktree...`);
	logger.log(`Creating worktree for ${branchName} (base: ${defaultBranch})...`);

	let worktreePath: string;
	try {
		worktreePath = await createWorktree(repoPath, branchName, defaultBranch);
	} catch (err) {
		stopSpinner();
		logger.error(`Failed to create worktree: ${err instanceof Error ? err.message : String(err)}`);
		return {
			success: false,
			providerUsed: models[0] ?? "claude",
			prUrls: [],
			fallback: {
				success: false,
				output: "",
				duration: 0,
				providerUsed: models[0] ?? "claude",
				attempts: [],
			},
		};
	}

	stopSpinner();
	logger.ok(`Worktree created at ${worktreePath}`);

	// Start lifecycle resources before implementation
	const repo = findRepoConfig(config, issue);
	if (repo?.lifecycle) {
		startSpinner(`${issue.id} \u2014 starting resources...`);
		const started = await startResources(repo, worktreePath);
		stopSpinner();
		if (!started) {
			logger.error(`Lifecycle startup failed for ${issue.id}. Aborting session.`);
			await cleanupWorktree(repoPath, worktreePath);
			return {
				success: false,
				providerUsed: models[0] ?? "claude",
				prUrls: [],
				fallback: {
					success: false,
					output: "",
					duration: 0,
					providerUsed: models[0] ?? "claude",
					attempts: [],
				},
			};
		}
	}

	// Detect test runner for prompt enhancement
	const testRunner = detectTestRunner(worktreePath);
	if (testRunner) {
		logger.log(`Detected test runner: ${testRunner}`);
	}

	const prompt = buildImplementPrompt(issue, config, testRunner);
	startSpinner(`${issue.id} \u2014 implementing...`);
	logger.log(`Implementing in worktree... (log: ${logFile})`);
	logger.initLogFile(logFile);

	const result = await runWithFallback(models, prompt, {
		logFile,
		cwd: worktreePath,
		guardrailsDir: repoPath,
		issueId: issue.id,
		overseer: config.overseer,
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

	// Stop lifecycle resources after implementation
	if (repo?.lifecycle) {
		await stopResources();
	}

	if (!result.success) {
		logger.error(`Session ${session} failed for ${issue.id}. Check ${logFile}`);
		await cleanupWorktree(repoPath, worktreePath);
		return { success: false, providerUsed: result.providerUsed, prUrls: [], fallback: result };
	}

	// Validate tests before creating PR
	startSpinner(`${issue.id} \u2014 validating tests...`);
	const testsPassed = await runTestValidation(worktreePath);
	stopSpinner();
	if (!testsPassed) {
		logger.error(`Tests failed for ${issue.id}. Blocking PR creation.`);
		await cleanupWorktree(repoPath, worktreePath);
		return { success: false, providerUsed: result.providerUsed, prUrls: [], fallback: result };
	}

	// Read manifest written by agent — used for English branch name and PR title
	const manifest = readLisaManifest(worktreePath);

	// Use agent's English branch name if provided and differs from the pre-generated name
	let effectiveBranch = branchName;
	if (manifest?.branch && manifest.branch !== branchName) {
		logger.log(`Renaming branch to English name: ${manifest.branch}`);
		try {
			await execa("git", ["branch", "-m", branchName, manifest.branch], { cwd: worktreePath });
			effectiveBranch = manifest.branch;
			logger.ok(`Branch renamed to ${effectiveBranch}`);
		} catch (err) {
			logger.warn(
				`Branch rename failed, using original: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	// Ensure branch is pushed to remote before creating PR (with hook recovery)
	startSpinner(`${issue.id} \u2014 pushing...`);
	const pushResult = await pushWithRecovery({
		branch: effectiveBranch,
		cwd: worktreePath,
		models,
		logFile,
		guardrailsDir: repoPath,
		issueId: issue.id,
		overseer: config.overseer,
	});
	stopSpinner();
	if (!pushResult.success) {
		logger.error(`Failed to push branch to remote: ${pushResult.error}`);
		cleanupManifest(worktreePath);
		await cleanupWorktree(repoPath, worktreePath);
		return { success: false, providerUsed: result.providerUsed, prUrls: [], fallback: result };
	}

	// Create PR from worktree
	startSpinner(`${issue.id} \u2014 creating PR...`);
	const prTitle = manifest?.prTitle ?? readPrTitle(worktreePath) ?? issue.title;
	cleanupPrTitle(worktreePath);
	cleanupManifest(worktreePath);

	const prUrls: string[] = [];
	try {
		const repoInfo = await getRepoInfo(worktreePath);
		const pr = await createPullRequest(
			{
				owner: repoInfo.owner,
				repo: repoInfo.repo,
				head: effectiveBranch,
				base: defaultBranch,
				title: prTitle,
				body: buildPrBody(issue, result.providerUsed),
			},
			config.github,
		);
		logger.ok(`PR created: ${pr.html_url}`);
		prUrls.push(pr.html_url);
	} catch (err) {
		logger.error(`Failed to create PR: ${err instanceof Error ? err.message : String(err)}`);
	}
	stopSpinner();

	await cleanupWorktree(repoPath, worktreePath);

	logger.ok(`Session ${session} complete for ${issue.id}`);
	return { success: true, providerUsed: result.providerUsed, prUrls, fallback: result };
}

async function runWorktreeMultiRepoSession(
	config: LisaConfig,
	issue: { id: string; title: string; url: string; description: string; repo?: string },
	logFile: string,
	session: number,
	models: ProviderName[],
): Promise<SessionResult> {
	const workspace = resolve(config.workspace);

	// Clean stale manifest from a previous interrupted run
	cleanupManifest(workspace);

	const prompt = buildWorktreeMultiRepoPrompt(issue, config);
	startSpinner(`${issue.id} \u2014 implementing...`);
	logger.log(`Multi-repo worktree session for ${issue.id} (agent selects repo and branch name)`);
	logger.log(`Implementing (agent selects repo)... (log: ${logFile})`);
	logger.initLogFile(logFile);

	const result = await runWithFallback(models, prompt, {
		logFile,
		cwd: workspace,
		guardrailsDir: workspace,
		issueId: issue.id,
		overseer: config.overseer,
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
		cleanupManifest(workspace);
		return { success: false, providerUsed: result.providerUsed, prUrls: [], fallback: result };
	}

	// Read manifest written by the provider
	const manifest = readLisaManifest(workspace);
	if (!manifest?.repoPath || !manifest.branch) {
		logger.error(
			`Agent did not produce a valid .lisa-manifest.json (requires repoPath + branch) for ${issue.id}. Aborting.`,
		);
		cleanupManifest(workspace);
		return { success: false, providerUsed: result.providerUsed, prUrls: [], fallback: result };
	}

	logger.ok(`Provider chose repo: ${manifest.repoPath}, branch: ${manifest.branch}`);

	const worktreePath = join(manifest.repoPath, ".worktrees", manifest.branch);
	const baseBranch = resolveBaseBranch(config, manifest.repoPath);

	// Use the worktree if the agent created it; fall back to repo root otherwise
	// (agent may skip worktree creation if the branch already exists with the implementation)
	const hasWorktree = existsSync(worktreePath);
	const effectiveCwd = hasWorktree ? worktreePath : manifest.repoPath;
	if (!hasWorktree) {
		logger.warn(`Worktree not found at ${worktreePath} — using repo root for git operations`);
	}

	// Validate tests from within the worktree (or repo root if no worktree)
	startSpinner(`${issue.id} \u2014 validating tests...`);
	const testsPassed = await runTestValidation(effectiveCwd);
	stopSpinner();
	if (!testsPassed) {
		logger.error(`Tests failed for ${issue.id}. Blocking PR creation.`);
		if (hasWorktree) await cleanupWorktree(manifest.repoPath, worktreePath);
		cleanupManifest(workspace);
		return { success: false, providerUsed: result.providerUsed, prUrls: [], fallback: result };
	}

	// Push branch to remote with hook recovery (Lisa always pushes — never the agent)
	startSpinner(`${issue.id} \u2014 pushing...`);
	const pushResult = await pushWithRecovery({
		branch: manifest.branch,
		cwd: effectiveCwd,
		models,
		logFile,
		guardrailsDir: manifest.repoPath,
		issueId: issue.id,
		overseer: config.overseer,
	});
	stopSpinner();
	if (!pushResult.success) {
		logger.error(`Failed to push branch to remote: ${pushResult.error}`);
		if (hasWorktree) await cleanupWorktree(manifest.repoPath, worktreePath);
		cleanupManifest(workspace);
		return { success: false, providerUsed: result.providerUsed, prUrls: [], fallback: result };
	}

	// Create PR
	startSpinner(`${issue.id} \u2014 creating PR...`);
	const prTitle = manifest.prTitle ?? issue.title;
	const prUrls: string[] = [];
	try {
		const repoInfo = await getRepoInfo(effectiveCwd);
		const pr = await createPullRequest(
			{
				owner: repoInfo.owner,
				repo: repoInfo.repo,
				head: manifest.branch,
				base: baseBranch,
				title: prTitle,
				body: buildPrBody(issue, result.providerUsed),
			},
			config.github,
		);
		logger.ok(`PR created: ${pr.html_url}`);
		prUrls.push(pr.html_url);
	} catch (err) {
		logger.error(`Failed to create PR: ${err instanceof Error ? err.message : String(err)}`);
	}
	stopSpinner();

	cleanupManifest(workspace);
	if (hasWorktree) await cleanupWorktree(manifest.repoPath, worktreePath);

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
	const workspace = resolve(config.workspace);

	// Clean any stale manifest from a previous interrupted run
	cleanupManifest(workspace);

	// Detect test runner for prompt enhancement
	const testRunner = detectTestRunner(workspace);
	if (testRunner) {
		logger.log(`Detected test runner: ${testRunner}`);
	}

	const prompt = buildImplementPrompt(issue, config, testRunner);

	// Start lifecycle resources before implementation
	const repo = findRepoConfig(config, issue);
	if (repo?.lifecycle) {
		startSpinner(`${issue.id} \u2014 starting resources...`);
		const cwd = resolve(workspace, repo.path);
		const started = await startResources(repo, cwd);
		stopSpinner();
		if (!started) {
			logger.error(`Lifecycle startup failed for ${issue.id}. Aborting session.`);
			return {
				success: false,
				providerUsed: models[0] ?? "claude",
				prUrls: [],
				fallback: {
					success: false,
					output: "",
					duration: 0,
					providerUsed: models[0] ?? "claude",
					attempts: [],
				},
			};
		}
	}

	startSpinner(`${issue.id} \u2014 implementing...`);
	logger.log(`Implementing... (log: ${logFile})`);
	logger.initLogFile(logFile);

	const result = await runWithFallback(models, prompt, {
		logFile,
		cwd: workspace,
		guardrailsDir: workspace,
		issueId: issue.id,
		overseer: config.overseer,
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

	// Stop lifecycle resources after implementation
	if (repo?.lifecycle) {
		await stopResources();
	}

	if (!result.success) {
		logger.error(`Session ${session} failed for ${issue.id}. Check ${logFile}`);
		return { success: false, providerUsed: result.providerUsed, prUrls: [], fallback: result };
	}

	// Validate tests before creating PR
	startSpinner(`${issue.id} \u2014 validating tests...`);
	const testsPassed = await runTestValidation(workspace);
	stopSpinner();
	if (!testsPassed) {
		logger.error(`Tests failed for ${issue.id}. Blocking PR creation.`);
		cleanupManifest(workspace);
		return { success: false, providerUsed: result.providerUsed, prUrls: [], fallback: result };
	}

	// Prefer manifest (agent writes repoPath + English branch name) over heuristic detection
	const manifest = readLisaManifest(workspace);
	let detected: { repoPath: string; branch: string }[];

	if (manifest?.repoPath && manifest.branch) {
		logger.ok(`Using manifest: repo=${manifest.repoPath}, branch=${manifest.branch}`);
		detected = [{ repoPath: manifest.repoPath, branch: manifest.branch }];
	} else {
		if (manifest) {
			logger.warn(`Manifest found but missing repoPath or branch — falling back to detection`);
		}
		detected = await detectFeatureBranches(config.repos, issue.id, workspace, config.base_branch);
	}

	cleanupManifest(workspace);

	if (detected.length === 0) {
		logger.error(`Could not detect feature branch for ${issue.id} — skipping PR creation`);
		logger.ok(`Session ${session} complete for ${issue.id}`);
		return { success: true, providerUsed: result.providerUsed, prUrls: [], fallback: result };
	}

	startSpinner(`${issue.id} \u2014 creating PR...`);
	const prTitle = manifest?.prTitle ?? readPrTitle(workspace) ?? issue.title;
	cleanupPrTitle(workspace);

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
					title: prTitle,
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
	stopSpinner();

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
