import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { analyzeProject } from "../context.js";
import { appendPlatformAttribution } from "../git/platform.js";
import { createWorktree, generateBranchName, getDiffStat } from "../git/worktree.js";
import * as logger from "../output/logger.js";
import { startSpinner, stopSpinner } from "../output/terminal.js";
import { getManifestPath, getPlanPath } from "../paths.js";
import {
	buildContinuationPrompt,
	buildPlanningPrompt,
	buildScopedImplementPrompt,
	detectPackageManager,
	detectTestRunner,
	type PreviousStepResult,
} from "../prompt.js";
import { runWithFallback } from "../providers/index.js";
import { readContext } from "../session/context-manager.js";
import { discoverInfra } from "../session/discovery.js";
import { runLifecycle, stopResources } from "../session/lifecycle.js";
import type { FallbackResult, Issue, LisaConfig, ModelSpec, PlanStep } from "../types/index.js";
import { kanbanEmitter } from "../ui/state.js";
import { resolveBaseBranch, resolveProviderOptions } from "./helpers.js";
import {
	cleanupPlanFile,
	extractPrUrlFromOutput,
	readManifestFile,
	readPlanFile,
} from "./manifest.js";
import type { SessionResult } from "./result.js";
import { activeProviderPids, userKilledSet, userSkippedSet } from "./state.js";
import { cleanupWorktree } from "./worktree-session.js";

export interface MultiRepoStepResult {
	success: boolean;
	providerUsed: string;
	branch: string;
	prUrl?: string;
	fallback: FallbackResult;
}

export async function runWorktreeMultiRepoSession(
	config: LisaConfig,
	issue: Issue,
	logFile: string,
	session: number,
	models: ModelSpec[],
): Promise<SessionResult> {
	const workspace = resolve(config.workspace);
	const planPath = getPlanPath(workspace, issue.id);

	logger.initLogFile(logFile);
	kanbanEmitter.emit("issue:log-file", issue.id, logFile);

	// Phase 1: Planning — reuse existing plan or generate a new one
	const cachedPlan = readPlanFile(planPath);
	let planProviderUsed: string = models[0]?.provider ?? "claude";
	let planFallback: FallbackResult | null = null;

	let sortedSteps: PlanStep[];
	if (cachedPlan?.steps && cachedPlan.steps.length > 0) {
		// Reuse plan from a previous failed attempt (avoids redundant planning)
		sortedSteps = [...cachedPlan.steps].sort((a, b) => a.order - b.order);
		logger.ok(
			`Reusing cached plan for ${issue.id}: ${sortedSteps.length} step(s) — ${sortedSteps.map((s) => s.repoPath).join(" → ")}`,
		);
	} else {
		startSpinner(`${issue.id} \u2014 analyzing issue...`);
		logger.log(`Multi-repo planning phase for ${issue.id}`);

		const globalContextMd = readContext(workspace);
		const planPrompt = buildPlanningPrompt(issue, config, planPath, globalContextMd);
		const planResult = await runWithFallback(models, planPrompt, {
			logFile,
			cwd: workspace,
			guardrailsDir: workspace,
			issueId: issue.id,
			overseer: config.overseer,
			sessionTimeout: config.loop.session_timeout,
			outputStallTimeout: config.loop.output_stall_timeout,
			providerOptions: resolveProviderOptions(config),
			onProcess: (pid) => {
				activeProviderPids.set(issue.id, pid);
			},
			shouldAbort: () => userKilledSet.has(issue.id) || userSkippedSet.has(issue.id),
			earlySuccess: () => {
				const p = readPlanFile(planPath);
				return !!(p?.steps && p.steps.length > 0);
			},
		});
		stopSpinner();
		planProviderUsed = planResult.providerUsed;
		planFallback = planResult;

		try {
			appendFileSync(
				logFile,
				`\n${"=".repeat(80)}\nPlanning phase — provider: ${planResult.providerUsed}\n${planResult.output}\n`,
			);
		} catch {}

		// Agent may exit with non-zero code but still write a valid plan (e.g.,
		// PTY EOF signal or timeout after the file was already flushed). Check the
		// plan file before considering the attempt failed.
		const plan = readPlanFile(planPath);
		if (!plan?.steps || plan.steps.length === 0) {
			if (!planResult.success) {
				logger.error(`Planning phase failed for ${issue.id}. Check ${logFile}`);
			} else {
				logger.error(`Agent did not produce a valid execution plan for ${issue.id}. Aborting.`);
			}
			cleanupPlanFile(planPath);
			activeProviderPids.delete(issue.id);
			return {
				success: false,
				providerUsed: planResult.providerUsed,
				prUrls: [],
				fallback: planResult,
			};
		}

		if (!planResult.success) {
			logger.warn(
				`Planning provider exited with error but plan file was written for ${issue.id}. Proceeding.`,
			);
		}

		sortedSteps = [...plan.steps].sort((a, b) => a.order - b.order);
		logger.ok(
			`Plan produced ${sortedSteps.length} step(s): ${sortedSteps.map((s) => s.repoPath).join(" → ")}`,
		);
	}

	const defaultFallback: FallbackResult = planFallback ?? {
		success: true,
		output: "",
		duration: 0,
		providerUsed: planProviderUsed,
		attempts: [],
	};

	// Phase 2: Sequential implementation — one session per repo step
	const prUrls: string[] = [];
	const previousResults: PreviousStepResult[] = [];
	let lastFallback: FallbackResult = defaultFallback;
	let lastProvider: string = planProviderUsed;

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
	// Clean up plan only on success — failed sessions reuse the cached plan on retry
	cleanupPlanFile(planPath);
	logger.ok(`Session ${session} complete for ${issue.id} — ${prUrls.length} PR(s) created`);
	return { success: true, providerUsed: lastProvider, prUrls, fallback: lastFallback };
}

export async function runMultiRepoStep(
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
	const repoContextMd = readContext(repoPath);

	// Detect infrastructure
	const infra = discoverInfra(worktreePath);
	let lifecycleEnv: Record<string, string> = {};
	if (infra) {
		startSpinner(`${issue.id} step ${stepNum} \u2014 starting resources...`);
		const started = await runLifecycle(infra, config.lifecycle, worktreePath);
		stopSpinner();
		if (!started.success) {
			logger.warn(
				`Lifecycle startup failed for step ${stepNum}. Continuing with manual resource instructions.`,
			);
		}
		lifecycleEnv = started.env;
	}

	// Run scoped implementation
	const workspace = resolve(config.workspace);
	// Manifest written within the worktree so all providers can access it
	const manifestPath = getManifestPath(worktreePath, issue.id);
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
		config.platform,
		repoContextMd,
	);
	startSpinner(`${issue.id} step ${stepNum} \u2014 implementing...`);

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
	if (infra) await stopResources();

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

	let prUrl = manifest?.prUrl;
	if (!prUrl) {
		const extractedUrl = extractPrUrlFromOutput(result.output);
		if (extractedUrl) {
			logger.warn(
				`Manifest missing prUrl for step ${stepNum}, extracted from output: ${extractedUrl}`,
			);
			prUrl = extractedUrl;
		} else {
			logger.warn(
				`Agent completed with code changes but no PR for step ${stepNum}. Attempting continuation...`,
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

			startSpinner(`${issue.id} step ${stepNum} — continuation...`);
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
					`\n${"=".repeat(80)}\nStep ${stepNum} continuation — provider: ${contResult.providerUsed}\n${contResult.output}\n`,
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
				logger.error(`Continuation also failed to produce PR for step ${stepNum}. Aborting.`);
				await cleanupWorktree(repoPath, worktreePath);
				return { ...failResult(result.providerUsed, result), branch: branchName };
			}
		}
	}

	await cleanupWorktree(repoPath, worktreePath);
	await appendPlatformAttribution(prUrl, result.providerUsed, config.platform);

	logger.ok(`Step ${stepNum} complete: ${repoPath} — PR: ${prUrl}`);
	return {
		success: true,
		providerUsed: result.providerUsed,
		branch: manifest?.branch ?? branchName,
		prUrl,
		fallback: result,
	};
}
