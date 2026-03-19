import { unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { analyzeProject } from "../context.js";
import { appendPlatformAttribution, appendPlatformProofOfWork } from "../git/platform.js";
import { hasCodeChanges } from "../git/worktree.js";
import * as logger from "../output/logger.js";
import { startSpinner, stopSpinner } from "../output/terminal.js";
import { getManifestPath } from "../paths.js";
import { buildImplementPrompt, detectPackageManager, detectTestRunner } from "../prompt.js";
import { runWithFallback } from "../providers/index.js";
import { readContext } from "../session/context-manager.js";
import { buildHookEnv, executeHook } from "../session/hooks.js";
import { stopResources } from "../session/lifecycle.js";
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

	// Detect and start infrastructure
	const lifecycleEnv = await startInfra(issue.id, workspace, config);

	// Hook: before_run (critical — abort on failure)
	if (!(await executeHook("before_run", config.hooks, workspace, hookEnv))) {
		return hookFailure(defaultProvider(models), "before_run hook failed");
	}

	const prompt = buildImplementPrompt(
		issue,
		config,
		testRunner,
		pm,
		projectContext,
		workspace,
		manifestPath,
		repoContextMd,
	);

	logger.initLogFile(logFile);
	kanbanEmitter.emit("issue:log-file", issue.id, logFile);
	startSpinner(`${issue.id} \u2014 implementing...`);
	logger.log(`Implementing... (log: ${logFile})`);

	// Start reconciliation monitor
	const reconciliation = startReconciliationMonitor(source, issue.id, config);

	const result = await runWithFallback(
		models,
		prompt,
		buildRunOptions(config, issue, workspace, logFile, workspace, lifecycleEnv),
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
		return failureResult(result.providerUsed, result);
	}

	const hasChanges = await hasCodeChanges(workspace, config.base_branch);
	if (!hasChanges) {
		return emptyCommitFailure(result);
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
	const validationResults = pow.results;

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
		} else {
			logger.error(`Agent did not produce a manifest with prUrl for ${issue.id}.`);
			return failureResult(result.providerUsed, result);
		}
	}

	logger.ok(`PR created by provider: ${prUrl}`);
	await appendPlatformAttribution(prUrl, result.providerUsed, config.platform);

	// Append proof of work to PR body if validation was run
	if (validationResults) {
		await appendPlatformProofOfWork(prUrl, validationResults, config.platform);
	}

	logger.ok(`Session ${session} complete for ${issue.id}`);
	return {
		success: true,
		providerUsed: result.providerUsed,
		prUrls: [prUrl],
		fallback: result,
	};
}
