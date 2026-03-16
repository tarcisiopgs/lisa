import { appendFileSync, unlinkSync } from "node:fs";
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
import { resolveProviderOptions } from "./helpers.js";
import { extractPrUrlFromOutput, readManifestFile } from "./manifest.js";
import type { SessionResult } from "./result.js";
import { activeProviderPids, reconciliationSet, userKilledSet, userSkippedSet } from "./state.js";

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
	if (infra) {
		startSpinner(`${issue.id} \u2014 starting resources...`);
		const started = await runLifecycle(infra, config.lifecycle, workspace);
		stopSpinner();
		if (!started.success) {
			logger.warn(
				`Lifecycle startup failed for ${issue.id}. Continuing with manual resource instructions.`,
			);
		}
		lifecycleEnv = started.env;
	}

	// Hook: before_run (critical — abort on failure)
	if (!(await executeHook("before_run", config.hooks, workspace, hookEnv))) {
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
		workspace,
		manifestPath,
		repoContextMd,
	);

	logger.initLogFile(logFile);
	kanbanEmitter.emit("issue:log-file", issue.id, logFile);
	startSpinner(`${issue.id} \u2014 implementing...`);
	logger.log(`Implementing... (log: ${logFile})`);

	// Start reconciliation monitor
	const reconciliation =
		source && config.reconciliation?.enabled
			? startReconciliation(source, issue.id, config.reconciliation, config.source_config)
			: null;

	const result = await runWithFallback(models, prompt, {
		logFile,
		cwd: workspace,
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
	await executeHook("after_run", config.hooks, workspace, hookEnv);

	// Check if issue was reconciled (status changed externally)
	if (reconciliationSet.has(issue.id)) {
		reconciliationSet.delete(issue.id);
		logger.warn(`Issue ${issue.id} was closed/cancelled externally. Skipping.`);
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

	// Proof of Work: run validation commands before PR creation
	let validationResults: ValidationResult[] | undefined;
	if (isProofOfWorkEnabled(config.proof_of_work)) {
		const pow = config.proof_of_work;
		let retriesLeft = pow?.max_retries ?? 2;
		let validationPassed = false;

		while (!validationPassed) {
			if (reconciliationSet.has(issue.id)) {
				reconciliationSet.delete(issue.id);
				logger.warn(`Issue ${issue.id} was closed/cancelled during validation. Skipping.`);
				return { success: false, providerUsed: result.providerUsed, prUrls: [], fallback: result };
			}

			startSpinner(`${issue.id} \u2014 validating...`);
			const results = await runValidationCommands(pow?.commands ?? [], workspace, pow?.timeout);
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
				cwd: workspace,
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
