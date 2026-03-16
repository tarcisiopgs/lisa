import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { execa } from "execa";
import { analyzeProject } from "../context.js";
import { appendPlatformAttribution, appendPlatformProofOfWork } from "../git/platform.js";
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
import {
	buildContinuationPrompt,
	buildImplementPrompt,
	buildNativeWorktreePrompt,
	detectPackageManager,
	detectTestRunner,
} from "../prompt.js";
import { createProvider, runWithFallback } from "../providers/index.js";
import { readContext } from "../session/context-manager.js";
import { discoverInfra } from "../session/discovery.js";
import { buildHookEnv, executeHook } from "../session/hooks.js";
import { runLifecycle, stopResources } from "../session/lifecycle.js";
import {
	buildValidationRecoveryPrompt,
	isProofOfWorkEnabled,
	runValidationCommands,
} from "../session/proof-of-work.js";
import { startReconciliation } from "../session/reconciliation.js";
import type { Issue, LisaConfig, ModelSpec, Source, ValidationResult } from "../types/index.js";
import { kanbanEmitter } from "../ui/state.js";
import { resolveBaseBranch, resolveProviderOptions } from "./helpers.js";
import {
	cleanupManifest,
	extractPrUrlFromOutput,
	readLisaManifest,
	readManifestFile,
} from "./manifest.js";
import { runWorktreeMultiRepoSession } from "./multi-repo-session.js";
import type { SessionResult } from "./result.js";
import { activeProviderPids, reconciliationSet, userKilledSet, userSkippedSet } from "./state.js";

export async function findWorktreeForBranch(
	repoRoot: string,
	branch: string,
): Promise<string | null> {
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
	try {
		const { stdout } = await execa("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot });
		const lines = stdout.split("\n");
		let currentPath: string | null = null;
		for (const line of lines) {
			if (line.startsWith("worktree ")) {
				currentPath = line.slice("worktree ".length);
			}
			if (line.startsWith("branch ") && line.toLowerCase().includes(needle)) {
				return currentPath;
			}
		}
		return null;
	} catch {
		return null;
	}
}

export async function cleanupWorktree(repoRoot: string, worktreePath: string): Promise<void> {
	try {
		await removeWorktree(repoRoot, worktreePath);
		logger.log("Worktree cleaned up.");
	} catch (err) {
		logger.warn(`Failed to clean up worktree: ${err instanceof Error ? err.message : String(err)}`);
	}
}

export async function runWorktreeSession(
	config: LisaConfig,
	issue: Issue,
	logFile: string,
	session: number,
	models: ModelSpec[],
	source?: Source,
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
): Promise<SessionResult> {
	const testRunner = detectTestRunner(repoPath);
	if (testRunner) logger.log(`Detected test runner: ${testRunner}`);
	const pm = detectPackageManager(repoPath);
	const projectContext = analyzeProject(repoPath);
	const repoContextMd = readContext(repoPath);

	const workspace = resolve(config.workspace);
	const hookEnv = buildHookEnv(issue.id, issue.title, "", repoPath);

	// Detect infrastructure
	const infra = discoverInfra(repoPath);
	let lifecycleEnv: Record<string, string> = {};
	if (infra) {
		startSpinner(`${issue.id} \u2014 starting resources...`);
		const started = await runLifecycle(infra, config.lifecycle, repoPath);
		stopSpinner();
		if (!started.success) {
			logger.warn(
				`Lifecycle startup failed for ${issue.id}. Continuing with manual resource instructions.`,
			);
		}
		lifecycleEnv = started.env;
	}

	// Clean stale manifest from previous run (per-issue)
	cleanupManifest(workspace, issue.id);

	// Hook: before_run
	if (!(await executeHook("before_run", config.hooks, repoPath, hookEnv))) {
		return {
			success: false,
			providerUsed: models[0]?.provider ?? "claude",
			prUrls: [],
			fallback: {
				success: false,
				output: "before_run hook failed",
				duration: 0,
				providerUsed: models[0]?.provider ?? "claude",
				attempts: [],
			},
		};
	}

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
	);
	logger.initLogFile(logFile);
	kanbanEmitter.emit("issue:log-file", issue.id, logFile);
	startSpinner(`${issue.id} \u2014 implementing (native worktree)...`);
	logger.log(`Implementing with native worktree... (log: ${logFile})`);

	// Start reconciliation monitor
	const reconciliation =
		source && config.reconciliation?.enabled
			? startReconciliation(source, issue.id, config.reconciliation, config.source_config)
			: null;

	const result = await runWithFallback(models, prompt, {
		logFile,
		cwd: repoPath,
		guardrailsDir: workspace,
		issueId: issue.id,
		overseer: config.overseer,
		sessionTimeout: config.loop.session_timeout,
		outputStallTimeout: config.loop.output_stall_timeout,
		providerOptions: resolveProviderOptions(config),
		useNativeWorktree: true,
		env: Object.keys(lifecycleEnv).length > 0 ? lifecycleEnv : undefined,
		onProcess: (pid) => {
			activeProviderPids.set(issue.id, pid);
		},
		shouldAbort: () => userKilledSet.has(issue.id) || userSkippedSet.has(issue.id),
	});
	stopSpinner();
	reconciliation?.stop();
	if (infra) await stopResources();

	// Hook: after_run (non-critical)
	await executeHook("after_run", config.hooks, repoPath, hookEnv);

	// Check if issue was reconciled (status changed externally)
	if (reconciliationSet.has(issue.id)) {
		reconciliationSet.delete(issue.id);
		logger.warn(`Issue ${issue.id} was closed/cancelled externally. Skipping.`);
		cleanupManifest(workspace, issue.id);
		return { success: false, providerUsed: result.providerUsed, prUrls: [], fallback: result };
	}

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

	const hasChanges = await hasCodeChanges(repoPath, _defaultBranch);
	if (!hasChanges) {
		logger.error(
			`Provider reported success but no code changes detected. Treating as failure for ${issue.id}.`,
		);
		cleanupManifest(workspace, issue.id);
		const emptyCommitResult: typeof result = {
			success: false,
			output: "Provider reported success but no code changes detected",
			duration: result.duration,
			providerUsed: result.providerUsed,
			attempts: [
				{
					provider: result.providerUsed,
					model: "",
					success: false,
					error: "Eligible error (empty commit)",
					duration: result.duration,
				},
			],
		};
		return {
			success: false,
			providerUsed: result.providerUsed,
			prUrls: [],
			fallback: emptyCommitResult,
		};
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
			const worktreePath = manifest?.branch
				? await findWorktreeForBranch(repoPath, manifest.branch)
				: null;
			if (worktreePath) await cleanupWorktree(repoPath, worktreePath);
			return { success: false, providerUsed: result.providerUsed, prUrls: [], fallback: result };
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
	if (worktreePath) await cleanupWorktree(repoPath, worktreePath);

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

	const hookEnv = buildHookEnv(issue.id, issue.title, branchName, worktreePath);

	// Hook: after_create (critical — abort on failure)
	if (!(await executeHook("after_create", config.hooks, worktreePath, hookEnv))) {
		await cleanupWorktree(repoPath, worktreePath);
		return {
			success: false,
			providerUsed: models[0]?.provider ?? "claude",
			prUrls: [],
			fallback: {
				success: false,
				output: "after_create hook failed",
				duration: 0,
				providerUsed: models[0]?.provider ?? "claude",
				attempts: [],
			},
		};
	}

	// Detect test runner for prompt enhancement
	const testRunner = detectTestRunner(worktreePath);
	if (testRunner) {
		logger.log(`Detected test runner: ${testRunner}`);
	}
	const pm = detectPackageManager(worktreePath);
	const projectContext = analyzeProject(worktreePath);
	const repoContextMd = readContext(repoPath);

	// Detect infrastructure
	const infra = discoverInfra(worktreePath);
	let lifecycleEnv: Record<string, string> = {};
	if (infra) {
		startSpinner(`${issue.id} \u2014 starting resources...`);
		const started = await runLifecycle(infra, config.lifecycle, worktreePath);
		stopSpinner();
		if (!started.success) {
			logger.warn(
				`Lifecycle startup failed for ${issue.id}. Continuing with manual resource instructions.`,
			);
		}
		lifecycleEnv = started.env;
	}

	const workspace = resolve(config.workspace);
	// Manifest written within the worktree so all providers (Gemini, OpenCode, etc.) can access it
	const manifestPath = getManifestPath(worktreePath, issue.id);

	// Hook: before_run (critical — abort on failure)
	if (!(await executeHook("before_run", config.hooks, worktreePath, hookEnv))) {
		await cleanupWorktree(repoPath, worktreePath);
		return {
			success: false,
			providerUsed: models[0]?.provider ?? "claude",
			prUrls: [],
			fallback: {
				success: false,
				output: "before_run hook failed",
				duration: 0,
				providerUsed: models[0]?.provider ?? "claude",
				attempts: [],
			},
		};
	}

	const prompt = buildImplementPrompt(
		issue,
		config,
		testRunner,
		pm,
		projectContext,
		worktreePath,
		manifestPath,
		repoContextMd,
	);
	logger.initLogFile(logFile);
	kanbanEmitter.emit("issue:log-file", issue.id, logFile);
	startSpinner(`${issue.id} \u2014 implementing...`);
	logger.log(`Implementing in worktree... (log: ${logFile})`);

	// Start reconciliation monitor
	const reconciliation =
		source && config.reconciliation?.enabled
			? startReconciliation(source, issue.id, config.reconciliation, config.source_config)
			: null;

	const result = await runWithFallback(models, prompt, {
		logFile,
		cwd: worktreePath,
		guardrailsDir: workspace,
		issueId: issue.id,
		overseer: config.overseer,
		sessionTimeout: config.loop.session_timeout,
		outputStallTimeout: config.loop.output_stall_timeout,
		providerOptions: resolveProviderOptions(config),
		env: Object.keys(lifecycleEnv).length > 0 ? lifecycleEnv : undefined,
		onProcess: (pid) => {
			activeProviderPids.set(issue.id, pid);
		},
		shouldAbort: () => userKilledSet.has(issue.id) || userSkippedSet.has(issue.id),
	});
	stopSpinner();
	reconciliation?.stop();
	if (infra) await stopResources();

	// Hook: after_run (non-critical)
	await executeHook("after_run", config.hooks, worktreePath, hookEnv);

	// Check if issue was reconciled (status changed externally)
	if (reconciliationSet.has(issue.id)) {
		reconciliationSet.delete(issue.id);
		logger.warn(`Issue ${issue.id} was closed/cancelled externally. Skipping.`);
		await cleanupWorktree(repoPath, worktreePath);
		return { success: false, providerUsed: result.providerUsed, prUrls: [], fallback: result };
	}

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
		// Hook: before_remove (non-critical)
		await executeHook("before_remove", config.hooks, worktreePath, hookEnv);
		await cleanupWorktree(repoPath, worktreePath);
		return { success: false, providerUsed: result.providerUsed, prUrls: [], fallback: result };
	}

	const hasChanges = await hasCodeChanges(worktreePath, baseBranch);
	if (!hasChanges) {
		logger.error(
			`Provider reported success but no code changes detected. Treating as failure for ${issue.id}.`,
		);
		// Hook: before_remove (non-critical)
		await executeHook("before_remove", config.hooks, worktreePath, hookEnv);
		await cleanupWorktree(repoPath, worktreePath);
		const emptyCommitResult: typeof result = {
			success: false,
			output: "Provider reported success but no code changes detected",
			duration: result.duration,
			providerUsed: result.providerUsed,
			attempts: [
				{
					provider: result.providerUsed,
					model: "",
					success: false,
					error: "Eligible error (empty commit)",
					duration: result.duration,
				},
			],
		};
		return {
			success: false,
			providerUsed: result.providerUsed,
			prUrls: [],
			fallback: emptyCommitResult,
		};
	}

	// Proof of Work: run validation commands before PR creation
	let validationResults: ValidationResult[] | undefined;
	if (isProofOfWorkEnabled(config.proof_of_work)) {
		const pow = config.proof_of_work;
		let retriesLeft = pow?.max_retries ?? 2;
		let validationPassed = false;

		while (!validationPassed) {
			// Check reconciliation during validation loop
			if (reconciliationSet.has(issue.id)) {
				reconciliationSet.delete(issue.id);
				logger.warn(`Issue ${issue.id} was closed/cancelled during validation. Skipping.`);
				await cleanupWorktree(repoPath, worktreePath);
				return { success: false, providerUsed: result.providerUsed, prUrls: [], fallback: result };
			}

			startSpinner(`${issue.id} \u2014 validating...`);
			const results = await runValidationCommands(pow?.commands ?? [], worktreePath, pow?.timeout);
			stopSpinner();

			const failures = results.filter((r) => !r.success);

			if (failures.length === 0) {
				validationPassed = true;
				validationResults = results;
				logger.ok(`All validation checks passed for ${issue.id}`);
				break;
			}

			if (retriesLeft <= 0) {
				logger.error(
					`Validation failed after max retries for ${issue.id}. Creating PR with failures noted.`,
				);
				validationResults = results;
				break;
			}

			retriesLeft--;
			logger.warn(
				`Validation failed for ${issue.id} (${retriesLeft} retries left). Re-invoking agent...`,
			);

			const recoveryPrompt = buildValidationRecoveryPrompt(issue, failures);
			startSpinner(`${issue.id} \u2014 fixing validation failures...`);
			const recoveryResult = await runWithFallback(models, recoveryPrompt, {
				logFile,
				cwd: worktreePath,
				guardrailsDir: workspace,
				issueId: issue.id,
				overseer: config.overseer,
				sessionTimeout: config.loop.session_timeout,
				outputStallTimeout: config.loop.output_stall_timeout,
				providerOptions: resolveProviderOptions(config),
				env: Object.keys(lifecycleEnv).length > 0 ? lifecycleEnv : undefined,
				onProcess: (pid) => {
					activeProviderPids.set(issue.id, pid);
				},
				shouldAbort: () => userKilledSet.has(issue.id) || userSkippedSet.has(issue.id),
			});
			stopSpinner();

			if (!recoveryResult.success) {
				logger.error(
					`Validation recovery failed for ${issue.id}. Creating PR with failures noted.`,
				);
				validationResults = results;
				break;
			}
		}
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
			const contResult = await runWithFallback(models, continuationPrompt, {
				logFile,
				cwd: worktreePath,
				guardrailsDir: workspace,
				issueId: issue.id,
				overseer: config.overseer,
				sessionTimeout: config.loop.session_timeout,
				outputStallTimeout: config.loop.output_stall_timeout,
				providerOptions: resolveProviderOptions(config),
				env: Object.keys(lifecycleEnv).length > 0 ? lifecycleEnv : undefined,
				onProcess: (pid) => {
					activeProviderPids.set(issue.id, pid);
				},
				shouldAbort: () => userKilledSet.has(issue.id) || userSkippedSet.has(issue.id),
			});
			stopSpinner();

			try {
				appendFileSync(
					logFile,
					`\n${"=".repeat(80)}\nContinuation \u2014 provider: ${contResult.providerUsed}\n${contResult.output}\n`,
				);
			} catch {}

			if (contResult.success) {
				const contManifest = readManifestFile(manifestPath);
				prUrl = contManifest?.prUrl;
				if (!prUrl) {
					prUrl = extractPrUrlFromOutput(contResult.output) ?? undefined;
				}
			}

			if (!prUrl) {
				logger.error(`Continuation also failed to produce PR for ${issue.id}. Aborting.`);
				// Hook: before_remove (non-critical)
				await executeHook("before_remove", config.hooks, worktreePath, hookEnv);
				await cleanupWorktree(repoPath, worktreePath);
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
	await appendPlatformAttribution(prUrl, result.providerUsed, config.platform);

	// Append proof of work to PR body if validation was run
	if (validationResults) {
		await appendPlatformProofOfWork(prUrl, validationResults, config.platform);
	}

	// Hook: before_remove (non-critical)
	await executeHook("before_remove", config.hooks, worktreePath, hookEnv);
	await cleanupWorktree(repoPath, worktreePath);

	logger.ok(`Session ${session} complete for ${issue.id}`);
	return {
		success: true,
		providerUsed: result.providerUsed,
		prUrls: [prUrl],
		fallback: result,
	};
}
