import { unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { analyzeProject } from "../context.js";
import { enrichContext } from "../enrichment.js";
import {
	appendPlatformAttribution,
	appendPlatformProofOfWork,
	appendPlatformSpecCompliance,
	applyPrReviewersAndAssignees,
} from "../git/platform.js";
import { hasCodeChanges } from "../git/worktree.js";
import * as logger from "../output/logger.js";
import { startSpinner, stopSpinner } from "../output/terminal.js";
import { getManifestPath } from "../paths.js";
import { buildImplementPrompt, detectPackageManager, detectTestRunner } from "../prompt/index.js";
import { runWithFallback } from "../providers/index.js";
import { isCiMonitorEnabled, monitorCi } from "../session/ci-monitor.js";
import { readContext } from "../session/context-manager.js";
import { buildHookEnv, executeHook } from "../session/hooks.js";
import { stopResources } from "../session/lifecycle.js";
import { ProgressReporter } from "../session/progress.js";
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
	runProofOfWork,
	runSpecCompliance,
	startInfra,
	startReconciliationMonitor,
} from "./helpers.js";
import { extractPrUrlFromOutput, readManifestFile } from "./manifest.js";
import type { SessionResult } from "./result.js";

export async function runBranchSession(
	config: LisaConfig,
	issue: Issue,
	logFile: string,
	session: number,
	models: ModelSpec[],
	source?: Source,
	slotIndex?: number,
): Promise<SessionResult> {
	const workspace = resolve(config.workspace);
	// Manifest written within the workspace so all providers can access it (branch mode is sequential)
	const manifestPath = getManifestPath(workspace, issue.id);
	const hookEnv = buildHookEnv(issue.id, issue.title, "", workspace);

	// Clean any stale manifest from a previous interrupted run
	try {
		unlinkSync(manifestPath);
	} catch {
		/* best-effort cleanup */
	}

	// Detect test runner for prompt enhancement
	const testRunner = detectTestRunner(workspace);
	if (testRunner) {
		logger.log(`Detected test runner: ${testRunner}`);
	}
	const pm = detectPackageManager(workspace);
	const projectContext = analyzeProject(workspace);
	const repoContextMd = readContext(workspace);
	const relevantFiles = await enrichContext(workspace, issue);

	// Detect and start infrastructure
	const lifecycleEnv = await startInfra(issue.id, workspace, config);

	// Hook: before_run (critical — abort on failure)
	if (!(await executeHook("before_run", config.hooks, workspace, hookEnv))) {
		return hookFailure(defaultProvider(models), "before_run hook failed");
	}

	// Progress comments
	const reporter = new ProgressReporter(
		source ?? ({ name: config.source } as Source),
		issue.id,
		config.progress_comments?.enabled === true && !!source,
	);
	await reporter.start();

	const prompt = buildImplementPrompt(
		issue,
		config,
		testRunner,
		pm,
		projectContext,
		workspace,
		manifestPath,
		repoContextMd,
		relevantFiles,
	);

	logger.initLogFile(logFile);
	kanbanEmitter.emit("issue:log-file", issue.id, logFile);
	startSpinner(`${issue.id} \u2014 implementing...`);
	logger.log(`Implementing... (log: ${logFile})`);

	await reporter.update("implementing", models[0]?.provider);

	// Start reconciliation monitor
	const reconciliation = startReconciliationMonitor(source, issue.id, config);

	const result = await runWithFallback(
		models,
		prompt,
		buildRunOptions(config, issue, workspace, logFile, workspace, lifecycleEnv, { slotIndex }),
	);
	stopSpinner();
	reconciliation?.stop();
	await stopResources();

	// Hook: after_run (non-critical)
	await executeHook("after_run", config.hooks, workspace, hookEnv);

	// Check if issue was reconciled (status changed externally)
	const reconciled = checkReconciliation(issue.id, result);
	if (reconciled) return reconciled;

	appendSessionLog(logFile, result);

	if (!result.success) {
		logger.error(`Session ${session} failed for ${issue.id}. Check ${logFile}`);
		await reporter.fail("Implementation failed");
		return failureResult(result.providerUsed, result);
	}

	// Read manifest early — the agent may have already pushed and created a PR
	// (e.g. in multi-repo setups where changes happen in a sub-repo). In that
	// case the root workspace has no git diff but the work is complete.
	const manifest = readManifestFile(manifestPath);
	try {
		unlinkSync(manifestPath);
	} catch {
		/* best-effort cleanup */
	}

	let prUrl = manifest?.prUrl;
	if (!prUrl) {
		const extractedUrl = extractPrUrlFromOutput(result.output);
		if (extractedUrl) {
			logger.warn(`Manifest missing prUrl for ${issue.id}, extracted from output: ${extractedUrl}`);
			prUrl = extractedUrl;
		}
	}

	// Skip code-change check when the agent already created a PR — the working
	// directory may be clean because the agent pushed from a sub-repo.
	if (!prUrl) {
		const hasChanges = await hasCodeChanges(workspace, config.base_branch);
		if (!hasChanges) {
			await reporter.fail("No code changes produced");
			return emptyCommitFailure(result);
		}
	}

	// Proof of Work: run validation commands before PR creation
	const pow = await runProofOfWork(
		config,
		issue,
		models,
		workspace,
		logFile,
		workspace,
		lifecycleEnv,
		result,
	);
	if (pow.reconciled) {
		return failureResult(result.providerUsed, result);
	}
	if (pow.blocked) {
		logger.error(`Skipping PR for ${issue.id} — validation failed with block_on_failure enabled.`);
		await reporter.fail("Validation failed");
		return failureResult(result.providerUsed, result);
	}
	const validationResults = pow.results;

	if (validationResults) {
		await reporter.update("validating", "Validation passed");
	}

	// Spec Compliance: verify implementation satisfies acceptance criteria via LLM
	const complianceResult = await runSpecCompliance(
		config,
		issue,
		models,
		workspace,
		config.base_branch,
		logFile,
		workspace,
		lifecycleEnv,
	);
	if (complianceResult.reconciled) {
		return failureResult(result.providerUsed, result);
	}
	if (complianceResult.blocked) {
		logger.error(
			`Skipping PR for ${issue.id} — spec compliance failed with block_on_failure enabled.`,
		);
		await reporter.fail("Spec compliance failed");
		return failureResult(result.providerUsed, result);
	}

	if (!prUrl) {
		logger.error(`Agent did not produce a manifest with prUrl for ${issue.id}.`);
		await reporter.fail("No PR URL produced");
		return failureResult(result.providerUsed, result);
	}

	logger.ok(`PR created by provider: ${prUrl}`);
	await appendPlatformAttribution(prUrl, result.providerUsed, config.platform);
	await applyPrReviewersAndAssignees(prUrl, config.pr, config.platform);

	// Emit per-card reviewer data to TUI
	if (config.pr?.reviewers?.length) {
		const applied = config.pr.reviewers.filter((r) => r !== "self");
		kanbanEmitter.emit("issue:reviewers-updated", issue.id, applied);
	}

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
		const manifestBranch = manifest?.branch;
		if (manifestBranch) {
			const ciResult = await monitorCi(
				manifestBranch,
				config,
				issue,
				models,
				workspace,
				logFile,
				workspace,
				lifecycleEnv,
				(extra) =>
					buildRunOptions(config, issue, workspace, logFile, workspace, lifecycleEnv, extra),
			);
			if (!ciResult.passed && !ciResult.skipped && config.ci_monitor?.block_on_failure) {
				logger.error(`CI failed for ${issue.id}. Blocking completion.`);
				return failureResult(result.providerUsed, result);
			}
		}
	}

	await reporter.finish([prUrl]);

	logger.ok(`Session ${session} complete for ${issue.id}`);
	return {
		success: true,
		providerUsed: result.providerUsed,
		prUrls: [prUrl],
		fallback: result,
	};
}
