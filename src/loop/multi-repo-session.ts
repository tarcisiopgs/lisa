import { appendFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { type ApiClientGenerator, analyzeProject, detectApiClientGenerator } from "../context.js";
import { appendPlatformAttribution } from "../git/platform.js";
import { createWorktree, generateBranchName } from "../git/worktree.js";
import * as logger from "../output/logger.js";
import { startSpinner, stopSpinner } from "../output/terminal.js";
import { getPlanPath } from "../paths.js";
import {
	buildPlanningPrompt,
	buildScopedImplementPrompt,
	buildStackInstructions,
	detectPackageManager,
	detectTestRunner,
	type PreviousStepResult,
} from "../prompt.js";
import { runWithFallback } from "../providers/index.js";
import { discoverInfra, discoverStackTools } from "../session/discovery.js";
import { resolveInfraStatus, runLifecycle, stopResources } from "../session/lifecycle.js";
import type { FallbackResult, Issue, LisaConfig, ModelSpec, PlanStep } from "../types/index.js";
import { kanbanEmitter } from "../ui/state.js";
import { resolveBaseBranch } from "./helpers.js";
import { extractPrUrlFromOutput, readManifestFile, readPlanFile } from "./manifest.js";
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

	// Clean stale plan from a previous interrupted run
	try {
		unlinkSync(planPath);
	} catch {}

	// Phase 1: Planning — agent analyzes issue and produces execution plan
	logger.initLogFile(logFile);
	kanbanEmitter.emit("issue:log-file", issue.id, logFile);
	startSpinner(`${issue.id} \u2014 analyzing issue...`);
	logger.log(`Multi-repo planning phase for ${issue.id}`);

	// Detect API client generators in each repo for planning context
	const repoGenerators = new Map<string, ApiClientGenerator>();
	for (const repo of config.repos) {
		const absPath = resolve(workspace, repo.path);
		const gen = detectApiClientGenerator(absPath);
		if (gen) repoGenerators.set(repo.name, gen);
	}

	const planPrompt = buildPlanningPrompt(issue, config, planPath, repoGenerators);
	const planResult = await runWithFallback(models, planPrompt, {
		logFile,
		cwd: workspace,
		guardrailsDir: workspace,
		issueId: issue.id,
		overseer: config.overseer,
		sessionTimeout: config.loop.session_timeout,
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

	// Detect stack tools and infrastructure
	const stackTools = discoverStackTools(worktreePath);
	const infra = discoverInfra(worktreePath);
	let lifecycleEnv: Record<string, string> = {};
	let lifecycleSuccess = true;
	if (infra) {
		startSpinner(`${issue.id} step ${stepNum} \u2014 starting resources...`);
		const started = await runLifecycle(infra, config.lifecycle, worktreePath);
		stopSpinner();
		lifecycleSuccess = started.success;
		if (!started.success) {
			logger.warn(
				`Lifecycle startup failed for step ${stepNum}. Continuing with manual resource instructions.`,
			);
		}
		lifecycleEnv = started.env;
	}
	const lifecycleMode = config.lifecycle?.mode ?? "skip";
	const infraStatus = resolveInfraStatus(lifecycleMode, { success: lifecycleSuccess });
	const stackBlock = buildStackInstructions(stackTools, infraStatus);

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
		config.platform,
	);
	const fullPrompt = stackBlock ? `${prompt}\n${stackBlock}` : prompt;
	startSpinner(`${issue.id} step ${stepNum} \u2014 implementing...`);

	const result = await runWithFallback(models, fullPrompt, {
		logFile,
		cwd: worktreePath,
		guardrailsDir: workspace,
		issueId: issue.id,
		overseer: config.overseer,
		sessionTimeout: config.loop.session_timeout,
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
			logger.error(`Agent did not produce a manifest with prUrl for step ${stepNum}.`);
			await cleanupWorktree(repoPath, worktreePath);
			return { ...failResult(result.providerUsed, result), branch: branchName };
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
