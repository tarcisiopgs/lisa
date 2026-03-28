import { resolve } from "node:path";
import { execa } from "execa";
import { analyzeProject } from "../context.js";
import { enrichContext } from "../enrichment.js";
import { formatError } from "../errors.js";
import {
	appendPlatformAttribution,
	appendPlatformProofOfWork,
	appendPlatformSpecCompliance,
	applyPrReviewersAndAssignees,
} from "../git/platform.js";
import {
	createWorktree,
	determineRepoPath,
	generateBranchName,
	getDiffStat,
	hasCodeChanges,
	removeWorktree,
} from "../git/worktree.js";
import * as logger from "../output/logger.js";
import { startSpinner, stopSpinner } from "../output/terminal.js";
import { getManifestPath } from "../paths.js";
import { buildLineagePromptBlock, loadLineageForIssue } from "../plan/lineage.js";
import {
	buildContinuationPrompt,
	buildImplementPrompt,
	buildNativeWorktreePrompt,
	detectPackageManager,
	detectTestRunner,
} from "../prompt.js";
import { createProvider, runWithFallback } from "../providers/index.js";
import { isCiMonitorEnabled, monitorCi } from "../session/ci-monitor.js";
import { readContext } from "../session/context-manager.js";
import { buildHookEnv, executeHook } from "../session/hooks.js";
import { stopResources } from "../session/lifecycle.js";
import { ProgressReporter } from "../session/progress.js";
import { isReviewMonitorEnabled, monitorReview } from "../session/review-monitor.js";
import { createSessionRecord, removeSessionRecord, updateSessionState } from "../session/state.js";
import type { Issue, LisaConfig, ModelSpec, Source } from "../types/index.js";
import { kanbanEmitter } from "../ui/state.js";
import {
	appendSessionLog,
	buildRunOptions,
	checkReconciliation,
	defaultProvider,
	emptyCommitFailure,
	failureResult,
	hookFailure,
	resolveBaseBranch,
	runProofOfWork,
	runSpecCompliance,
	startInfra,
	startReconciliationMonitor,
} from "./helpers.js";
import {
	cleanupManifest,
	extractPrUrlFromOutput,
	readLisaManifest,
	readManifestFile,
} from "./manifest.js";
import { runWorktreeMultiRepoSession } from "./multi-repo-session.js";
import type { SessionResult } from "./result.js";

async function findWorktree(
	repoRoot: string,
	predicate: (branchLine: string) => boolean,
): Promise<string | null> {
	try {
		const { stdout } = await execa("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot });
		const lines = stdout.split("\n");
		let currentPath: string | null = null;
		for (const line of lines) {
			if (line.startsWith("worktree ")) {
				currentPath = line.slice("worktree ".length);
			}
			if (line.startsWith("branch ") && predicate(line)) {
				return currentPath;
			}
		}
		return null;
	} catch {
		/* non-fatal: git operation may fail */
		return null;
	}
}

export async function findWorktreeForBranch(
	repoRoot: string,
	branch: string,
): Promise<string | null> {
	return findWorktree(repoRoot, (line) => line.endsWith(`/${branch}`));
}

/**
 * Fallback: find a worktree whose branch name contains the issue ID slug.
 * Used when the manifest is missing the branch name in native worktree mode.
 */
export async function findWorktreeByIssueId(
	repoRoot: string,
	issueId: string,
): Promise<string | null> {
	if (!issueId) return null;
	const needle = issueId.toLowerCase().replace(/[^a-z0-9-]/g, "-");
	return findWorktree(repoRoot, (line) => line.toLowerCase().includes(needle));
}

export async function cleanupWorktree(repoRoot: string, worktreePath: string): Promise<void> {
	try {
		await removeWorktree(repoRoot, worktreePath);
		logger.log("Worktree cleaned up.");
	} catch (err) {
		logger.warn(`Failed to clean up worktree: ${formatError(err)}`);
	}
}

export async function runWorktreeSession(
	config: LisaConfig,
	issue: Issue,
	logFile: string,
	session: number,
	models: ModelSpec[],
	source?: Source,
	slotIndex?: number,
): Promise<SessionResult> {
	// Multi-repo: delegate to planning + sequential sessions
	if (config.repos.length > 1) {
		return runWorktreeMultiRepoSession(config, issue, logFile, session, models, source);
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
			source,
			slotIndex,
		);
	}

	return runManualWorktreeSession(
		config,
		issue,
		logFile,
		session,
		models,
		repoPath,
		defaultBranch,
		source,
		slotIndex,
	);
}

export async function runNativeWorktreeSession(
	config: LisaConfig,
	issue: Issue,
	logFile: string,
	session: number,
	models: ModelSpec[],
	repoPath: string,
	_defaultBranch: string,
	source?: Source,
	slotIndex?: number,
): Promise<SessionResult> {
	const testRunner = detectTestRunner(repoPath);
	if (testRunner) logger.log(`Detected test runner: ${testRunner}`);
	const pm = detectPackageManager(repoPath);
	const projectContext = analyzeProject(repoPath);
	const repoContextMd = readContext(repoPath);
	const relevantFiles = enrichContext(repoPath, issue);

	const workspace = resolve(config.workspace);
	const hookEnv = buildHookEnv(issue.id, issue.title, "", repoPath);

	// Detect infrastructure
	const lifecycleEnv = await startInfra(issue.id, repoPath, config);

	// Clean stale manifest from previous run (per-issue)
	cleanupManifest(workspace, issue.id);

	// Hook: before_run
	if (!(await executeHook("before_run", config.hooks, repoPath, hookEnv))) {
		return hookFailure(defaultProvider(models), "before_run hook failed");
	}

	// Progress comments
	const reporter = new ProgressReporter(
		source ?? ({ name: config.source } as Source),
		issue.id,
		config.progress_comments?.enabled === true && !!source,
	);
	await reporter.start();

	const prompt = buildNativeWorktreePrompt(
		issue,
		repoPath,
		testRunner,
		pm,
		_defaultBranch,
		projectContext,
		getManifestPath(workspace, issue.id),
		config.platform,
		repoContextMd,
		relevantFiles,
	);
	logger.initLogFile(logFile);
	kanbanEmitter.emit("issue:log-file", issue.id, logFile);
	startSpinner(`${issue.id} \u2014 implementing (native worktree)...`);
	logger.log(`Implementing with native worktree... (log: ${logFile})`);

	await reporter.update("implementing", models[0]?.provider);

	// Start reconciliation monitor
	const reconciliation = startReconciliationMonitor(source, issue.id, config);

	const result = await runWithFallback(
		models,
		prompt,
		buildRunOptions(config, issue, repoPath, logFile, workspace, lifecycleEnv, {
			useNativeWorktree: true,
			slotIndex,
		}),
	);
	stopSpinner();
	reconciliation?.stop();
	if (Object.keys(lifecycleEnv).length > 0) await stopResources();

	// Hook: after_run (non-critical)
	await executeHook("after_run", config.hooks, repoPath, hookEnv);

	// Check if issue was reconciled (status changed externally)
	const reconciled = checkReconciliation(issue.id, result);
	if (reconciled) {
		cleanupManifest(workspace, issue.id);
		return reconciled;
	}

	appendSessionLog(logFile, result);

	if (!result.success) {
		logger.error(`Session ${session} failed for ${issue.id}. Check ${logFile}`);
		await reporter.fail("Implementation failed");
		cleanupManifest(workspace, issue.id);
		return failureResult(result.providerUsed, result);
	}

	const hasChanges = await hasCodeChanges(repoPath, _defaultBranch);
	if (!hasChanges) {
		await reporter.fail("No code changes produced");
		cleanupManifest(workspace, issue.id);
		return emptyCommitFailure(result);
	}

	const manifest = readLisaManifest(workspace, issue.id);
	cleanupManifest(workspace, issue.id);

	let prUrl = manifest?.prUrl;
	if (!prUrl) {
		const extractedUrl = extractPrUrlFromOutput(result.output);
		if (extractedUrl) {
			logger.warn(`Manifest missing prUrl for ${issue.id}, extracted from output: ${extractedUrl}`);
			prUrl = extractedUrl;
		} else {
			logger.error(`Agent did not produce a manifest with prUrl for ${issue.id}. Aborting.`);
			await reporter.fail("No PR URL produced");
			const worktreePath = manifest?.branch
				? await findWorktreeForBranch(repoPath, manifest.branch)
				: null;
			if (worktreePath) await cleanupWorktree(repoPath, worktreePath);
			return failureResult(result.providerUsed, result);
		}
	}

	let worktreePath = manifest?.branch
		? await findWorktreeForBranch(repoPath, manifest.branch)
		: null;
	// Fallback: scan worktrees by issue ID slug when manifest branch is missing
	if (!worktreePath) {
		worktreePath = await findWorktreeByIssueId(repoPath, issue.id);
	}
	logger.ok(`PR created by provider: ${prUrl}`);
	await appendPlatformAttribution(prUrl, result.providerUsed, config.platform);
	await applyPrReviewersAndAssignees(prUrl, config.pr, config.platform);

	// CI Monitor: poll CI and fix failures if enabled
	if (isCiMonitorEnabled(config.ci_monitor)) {
		const manifestBranch = manifest?.branch;
		if (manifestBranch) {
			const ciResult = await monitorCi(
				manifestBranch,
				config,
				issue,
				models,
				repoPath,
				logFile,
				workspace,
				{},
				(extra) => buildRunOptions(config, issue, repoPath, logFile, workspace, {}, extra),
			);
			if (!ciResult.passed && !ciResult.skipped && config.ci_monitor?.block_on_failure) {
				logger.error(`CI failed for ${issue.id}. Blocking completion.`);
				if (worktreePath) await cleanupWorktree(repoPath, worktreePath);
				return failureResult(result.providerUsed, result);
			}
		}
	}

	if (worktreePath) await cleanupWorktree(repoPath, worktreePath);

	await reporter.finish([prUrl]);

	logger.ok(`Session ${session} complete for ${issue.id}`);
	return {
		success: true,
		providerUsed: result.providerUsed,
		prUrls: [prUrl],
		fallback: result,
	};
}

export async function runManualWorktreeSession(
	config: LisaConfig,
	issue: Issue,
	logFile: string,
	session: number,
	models: ModelSpec[],
	repoPath: string,
	defaultBranch: string,
	source?: Source,
	slotIndex?: number,
): Promise<SessionResult> {
	const branchName = generateBranchName(issue.id, issue.title);
	const workspace = resolve(config.workspace);

	// Use dependency branch as base when available (PR stacking)
	const baseBranch = issue.dependency?.branch ?? defaultBranch;

	startSpinner(`${issue.id} \u2014 creating worktree...`);
	logger.log(`Creating worktree for ${branchName} (base: ${baseBranch})...`);

	let worktreePath: string;
	try {
		worktreePath = await createWorktree(repoPath, branchName, baseBranch);
	} catch (err) {
		stopSpinner();
		logger.error(`Failed to create worktree: ${formatError(err)}`);
		return hookFailure(defaultProvider(models), "");
	}

	stopSpinner();
	logger.ok(`Worktree created at ${worktreePath}`);
	createSessionRecord(workspace, issue.id, { branch: branchName, worktreePath });

	const hookEnv = buildHookEnv(issue.id, issue.title, branchName, worktreePath);

	// Hook: after_create (critical — abort on failure)
	if (!(await executeHook("after_create", config.hooks, worktreePath, hookEnv))) {
		await cleanupWorktree(repoPath, worktreePath);
		removeSessionRecord(workspace, issue.id);
		return hookFailure(defaultProvider(models), "after_create hook failed");
	}

	// Detect test runner for prompt enhancement
	const testRunner = detectTestRunner(worktreePath);
	if (testRunner) {
		logger.log(`Detected test runner: ${testRunner}`);
	}
	const pm = detectPackageManager(worktreePath);
	const projectContext = analyzeProject(worktreePath);
	const repoContextMd = readContext(repoPath);
	const relevantFiles = enrichContext(worktreePath, issue);

	// Detect infrastructure
	const lifecycleEnv = await startInfra(issue.id, worktreePath, config);

	// Manifest written within the worktree so all providers (Gemini, OpenCode, etc.) can access it
	const manifestPath = getManifestPath(worktreePath, issue.id);

	// Hook: before_run (critical — abort on failure)
	if (!(await executeHook("before_run", config.hooks, worktreePath, hookEnv))) {
		await cleanupWorktree(repoPath, worktreePath);
		removeSessionRecord(workspace, issue.id);
		return hookFailure(defaultProvider(models), "before_run hook failed");
	}

	// Progress comments
	const reporter = new ProgressReporter(
		source ?? ({ name: config.source } as Source),
		issue.id,
		config.progress_comments?.enabled === true && !!source,
	);
	await reporter.start();

	const lineage = loadLineageForIssue(workspace, issue.id);
	const lineageBlock = lineage ? buildLineagePromptBlock(lineage, issue.id) : null;

	const prompt = buildImplementPrompt(
		issue,
		config,
		testRunner,
		pm,
		projectContext,
		worktreePath,
		manifestPath,
		repoContextMd,
		relevantFiles,
		lineageBlock,
	);
	logger.initLogFile(logFile);
	kanbanEmitter.emit("issue:log-file", issue.id, logFile);
	startSpinner(`${issue.id} \u2014 implementing...`);
	logger.log(`Implementing in worktree... (log: ${logFile})`);

	await reporter.update("implementing", models[0]?.provider);

	// Start reconciliation monitor
	const reconciliation = startReconciliationMonitor(source, issue.id, config);

	updateSessionState(workspace, issue.id, "implementing");
	kanbanEmitter.emit("issue:substatus", issue.id, "implementing");

	const result = await runWithFallback(
		models,
		prompt,
		buildRunOptions(config, issue, worktreePath, logFile, workspace, lifecycleEnv, {
			slotIndex,
		}),
	);
	stopSpinner();
	reconciliation?.stop();
	if (Object.keys(lifecycleEnv).length > 0) await stopResources();

	// Hook: after_run (non-critical)
	await executeHook("after_run", config.hooks, worktreePath, hookEnv);

	// Check if issue was reconciled (status changed externally)
	const reconciled = checkReconciliation(issue.id, result);
	if (reconciled) {
		await cleanupWorktree(repoPath, worktreePath);
		removeSessionRecord(workspace, issue.id);
		return reconciled;
	}

	appendSessionLog(logFile, result);

	if (!result.success) {
		logger.error(`Session ${session} failed for ${issue.id}. Check ${logFile}`);
		await reporter.fail("Implementation failed");
		// Hook: before_remove (non-critical)
		await executeHook("before_remove", config.hooks, worktreePath, hookEnv);
		await cleanupWorktree(repoPath, worktreePath);
		removeSessionRecord(workspace, issue.id);
		return failureResult(result.providerUsed, result);
	}

	const hasChanges = await hasCodeChanges(worktreePath, baseBranch);
	if (!hasChanges) {
		await reporter.fail("No code changes produced");
		// Hook: before_remove (non-critical)
		await executeHook("before_remove", config.hooks, worktreePath, hookEnv);
		await cleanupWorktree(repoPath, worktreePath);
		removeSessionRecord(workspace, issue.id);
		return emptyCommitFailure(result);
	}

	// Proof of Work: run validation commands before PR creation
	const powResult = await runProofOfWork(
		config,
		issue,
		models,
		worktreePath,
		logFile,
		workspace,
		lifecycleEnv,
		result,
	);
	if (powResult.reconciled) {
		await cleanupWorktree(repoPath, worktreePath);
		removeSessionRecord(workspace, issue.id);
		return failureResult(result.providerUsed, result);
	}
	if (powResult.blocked) {
		logger.error(`Skipping PR for ${issue.id} — validation failed with block_on_failure enabled.`);
		await reporter.fail("Validation failed");
		await executeHook("before_remove", config.hooks, worktreePath, hookEnv);
		await cleanupWorktree(repoPath, worktreePath);
		removeSessionRecord(workspace, issue.id);
		return failureResult(result.providerUsed, result);
	}
	const validationResults = powResult.results;

	if (validationResults) {
		await reporter.update("validating", "Validation passed");
		updateSessionState(workspace, issue.id, "validating");
		kanbanEmitter.emit("issue:substatus", issue.id, "validating");
	}

	// Spec Compliance: verify implementation satisfies acceptance criteria via LLM
	const complianceResult = await runSpecCompliance(
		config,
		issue,
		models,
		worktreePath,
		baseBranch,
		logFile,
		workspace,
		lifecycleEnv,
	);
	if (complianceResult.reconciled) {
		await cleanupWorktree(repoPath, worktreePath);
		removeSessionRecord(workspace, issue.id);
		return failureResult(result.providerUsed, result);
	}
	if (complianceResult.blocked) {
		logger.error(
			`Skipping PR for ${issue.id} — spec compliance failed with block_on_failure enabled.`,
		);
		await reporter.fail("Spec compliance failed");
		await executeHook("before_remove", config.hooks, worktreePath, hookEnv);
		await cleanupWorktree(repoPath, worktreePath);
		removeSessionRecord(workspace, issue.id);
		return failureResult(result.providerUsed, result);
	}

	// Read manifest from worktree (accessible by all providers; worktree cleanup removes it)
	const manifest = readManifestFile(manifestPath);

	let prUrl = manifest?.prUrl;
	if (!prUrl) {
		const extractedUrl = extractPrUrlFromOutput(result.output);
		if (extractedUrl) {
			logger.warn(`Manifest missing prUrl for ${issue.id}, extracted from output: ${extractedUrl}`);
			prUrl = extractedUrl;
		} else {
			// Attempt continuation: provider succeeded with code changes but no PR
			logger.warn(
				`Agent completed with code changes but no PR for ${issue.id}. Attempting continuation...`,
			);

			const diffStat = await getDiffStat(worktreePath, baseBranch);
			const continuationPrompt = buildContinuationPrompt({
				issue: { id: issue.id, title: issue.title },
				diffStat,
				previousOutput: result.output,
				platform: config.platform,
				baseBranch,
				manifestPath,
			});

			startSpinner(`${issue.id} \u2014 continuation...`);
			const contResult = await runWithFallback(
				models,
				continuationPrompt,
				buildRunOptions(config, issue, worktreePath, logFile, workspace, lifecycleEnv, {
					slotIndex,
				}),
			);
			stopSpinner();

			appendSessionLog(logFile, contResult);

			if (contResult.success) {
				const contManifest = readManifestFile(manifestPath);
				prUrl = contManifest?.prUrl;
				if (!prUrl) {
					prUrl = extractPrUrlFromOutput(contResult.output) ?? undefined;
				}
			}

			if (!prUrl) {
				logger.error(`Continuation also failed to produce PR for ${issue.id}. Aborting.`);
				await reporter.fail("No PR URL produced");
				// Hook: before_remove (non-critical)
				await executeHook("before_remove", config.hooks, worktreePath, hookEnv);
				await cleanupWorktree(repoPath, worktreePath);
				removeSessionRecord(workspace, issue.id);
				return {
					success: false,
					providerUsed: result.providerUsed,
					prUrls: [],
					fallback: contResult,
				};
			}
		}
	}

	logger.ok(`PR created by provider: ${prUrl}`);
	updateSessionState(workspace, issue.id, "pr_created", { prUrl });
	kanbanEmitter.emit("issue:substatus", issue.id, "PR created");
	await appendPlatformAttribution(prUrl, result.providerUsed, config.platform);
	await applyPrReviewersAndAssignees(prUrl, config.pr, config.platform);

	// Append proof of work to PR body if validation was run
	if (validationResults) {
		await appendPlatformProofOfWork(prUrl, validationResults, config.platform);
	}

	// Append spec compliance results to PR body if check was run
	if (complianceResult.result) {
		await appendPlatformSpecCompliance(prUrl, complianceResult.result, config.platform);
	}

	// CI Monitor: poll CI and fix failures if enabled
	if (isCiMonitorEnabled(config.ci_monitor)) {
		updateSessionState(workspace, issue.id, "ci_monitoring");
		kanbanEmitter.emit("issue:substatus", issue.id, "CI");
		const manifestBranch = manifest?.branch ?? branchName;
		const ciResult = await monitorCi(
			manifestBranch,
			config,
			issue,
			models,
			worktreePath,
			logFile,
			workspace,
			lifecycleEnv,
			(extra) =>
				buildRunOptions(config, issue, worktreePath, logFile, workspace, lifecycleEnv, extra),
		);
		if (!ciResult.passed && !ciResult.skipped && config.ci_monitor?.block_on_failure) {
			logger.error(`CI failed for ${issue.id}. Blocking completion (block_on_failure=true).`);
			await executeHook("before_remove", config.hooks, worktreePath, hookEnv);
			await cleanupWorktree(repoPath, worktreePath);
			removeSessionRecord(workspace, issue.id);
			return failureResult(result.providerUsed, result);
		}
	}

	// Review Monitor: poll for review feedback and address changes if enabled
	if (isReviewMonitorEnabled(config.review_monitor) && prUrl) {
		const manifestBranch = manifest?.branch ?? branchName;
		const reviewResult = await monitorReview(
			prUrl,
			manifestBranch,
			config,
			issue,
			models,
			worktreePath,
			logFile,
			workspace,
			lifecycleEnv,
			(extra) =>
				buildRunOptions(config, issue, worktreePath, logFile, workspace, lifecycleEnv, extra),
		);

		if (
			reviewResult.finalState === "changes_requested" &&
			config.review_monitor?.block_on_failure
		) {
			logger.error(`Review not addressed for ${issue.id}. Blocking completion.`);
			await executeHook("before_remove", config.hooks, worktreePath, hookEnv);
			await cleanupWorktree(repoPath, worktreePath);
			removeSessionRecord(workspace, issue.id);
			return failureResult(result.providerUsed, result);
		}
	}

	// Hook: before_remove (non-critical)
	await executeHook("before_remove", config.hooks, worktreePath, hookEnv);
	await cleanupWorktree(repoPath, worktreePath);

	await reporter.finish([prUrl]);

	updateSessionState(workspace, issue.id, "done");
	removeSessionRecord(workspace, issue.id);

	logger.ok(`Session ${session} complete for ${issue.id}`);
	return {
		success: true,
		providerUsed: result.providerUsed,
		prUrls: [prUrl],
		fallback: result,
	};
}
