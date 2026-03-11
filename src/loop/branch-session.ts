import { appendFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { analyzeProject } from "../context.js";
import { appendPlatformAttribution } from "../git/platform.js";
import { hasCodeChanges } from "../git/worktree.js";
import * as logger from "../output/logger.js";
import { startSpinner, stopSpinner } from "../output/terminal.js";
import { getManifestPath } from "../paths.js";
import { buildImplementPrompt, detectPackageManager, detectTestRunner } from "../prompt.js";
import { runWithFallback } from "../providers/index.js";
import { readContext } from "../session/context-manager.js";
import { discoverInfra } from "../session/discovery.js";
import { runLifecycle, stopResources } from "../session/lifecycle.js";
import type { Issue, LisaConfig, ModelSpec } from "../types/index.js";
import { kanbanEmitter } from "../ui/state.js";
import { extractPrUrlFromOutput, readManifestFile } from "./manifest.js";
import type { SessionResult } from "./result.js";
import { activeProviderPids, userKilledSet, userSkippedSet } from "./state.js";

export async function runBranchSession(
	config: LisaConfig,
	issue: Issue,
	logFile: string,
	session: number,
	models: ModelSpec[],
): Promise<SessionResult> {
	const workspace = resolve(config.workspace);
	// Manifest written within the workspace so all providers can access it (branch mode is sequential)
	const manifestPath = getManifestPath(workspace, issue.id);

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
	const repoContextMd = readContext(workspace);

	// Detect infrastructure
	const infra = discoverInfra(workspace);
	let lifecycleEnv: Record<string, string> = {};
	let lifecycleSuccess = true;
	if (infra) {
		startSpinner(`${issue.id} \u2014 starting resources...`);
		const started = await runLifecycle(infra, config.lifecycle, workspace);
		stopSpinner();
		lifecycleSuccess = started.success;
		if (!started.success) {
			logger.warn(
				`Lifecycle startup failed for ${issue.id}. Continuing with manual resource instructions.`,
			);
		}
		lifecycleEnv = started.env;
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

	const result = await runWithFallback(models, prompt, {
		logFile,
		cwd: workspace,
		guardrailsDir: workspace,
		issueId: issue.id,
		overseer: config.overseer,
		sessionTimeout: config.loop.session_timeout,
		outputStallTimeout: config.loop.output_stall_timeout,
		env: Object.keys(lifecycleEnv).length > 0 ? lifecycleEnv : undefined,
		onProcess: (pid) => {
			activeProviderPids.set(issue.id, pid);
		},
		shouldAbort: () => userKilledSet.has(issue.id) || userSkippedSet.has(issue.id),
	});
	stopSpinner();
	if (infra) await stopResources();

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

	const hasChanges = await hasCodeChanges(workspace, config.base_branch);
	if (!hasChanges) {
		logger.error(
			`Provider reported success but no code changes detected. Treating as failure for ${issue.id}.`,
		);
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

	const manifest = readManifestFile(manifestPath);
	try {
		unlinkSync(manifestPath);
	} catch {}

	let prUrl = manifest?.prUrl;
	if (!prUrl) {
		const extractedUrl = extractPrUrlFromOutput(result.output);
		if (extractedUrl) {
			logger.warn(`Manifest missing prUrl for ${issue.id}, extracted from output: ${extractedUrl}`);
			prUrl = extractedUrl;
		} else {
			logger.error(`Agent did not produce a manifest with prUrl for ${issue.id}.`);
			return { success: false, providerUsed: result.providerUsed, prUrls: [], fallback: result };
		}
	}

	logger.ok(`PR created by provider: ${prUrl}`);
	await appendPlatformAttribution(prUrl, result.providerUsed, config.platform);
	logger.ok(`Session ${session} complete for ${issue.id}`);
	return {
		success: true,
		providerUsed: result.providerUsed,
		prUrls: [prUrl],
		fallback: result,
	};
}
