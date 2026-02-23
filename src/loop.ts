import { appendFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { execa } from "execa";
import { startResources, stopResources } from "./lifecycle.js";
import * as logger from "./logger.js";
import {
	buildImplementPrompt,
	buildNativeWorktreePrompt,
	buildPlanningPrompt,
	buildScopedImplementPrompt,
	detectPackageManager,
	detectTestRunner,
	type PreviousStepResult,
} from "./prompt.js";
import {
	createProvider,
	isCompleteProviderExhaustion,
	runWithFallback,
} from "./providers/index.js";
import { createSource } from "./sources/index.js";
import { notify, resetTitle, setTitle, startSpinner, stopSpinner } from "./terminal.js";
import type {
	ExecutionPlan,
	FallbackResult,
	LisaConfig,
	ModelSpec,
	PlanStep,
	RepoConfig,
	Source,
} from "./types.js";
import {
	createWorktree,
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

function resolveModels(config: LisaConfig): ModelSpec[] {
	if (!config.models || config.models.length === 0) {
		return [{ provider: config.provider }];
	}
	const knownProviders = new Set<string>(["claude", "gemini", "opencode", "copilot", "cursor"]);
	for (const m of config.models) {
		if (knownProviders.has(m) && m !== config.provider) {
			logger.warn(
				`Model "${m}" looks like a provider name but provider is "${config.provider}". ` +
					`Since v1.4.0, "models" lists model names within the configured provider, not provider names. ` +
					`Update your .lisa/config.yaml.`,
			);
		}
	}

	if (config.provider === "cursor") {
		const hasAuto = config.models.some((m) => m.toLowerCase() === "auto");
		if (!hasAuto) {
			logger.warn(
				"Cursor Free plan detected (or model not set to 'auto'). Forcing 'auto' model. " +
					"Set model to 'auto' explicitly in .lisa/config.yaml to silence this warning.",
			);
			return [{ provider: config.provider, model: "auto" }];
		}
	}

	return config.models.map((m) => ({
		provider: config.provider,
		model: m === config.provider ? undefined : m,
	}));
}

const PLAN_FILE = ".lisa-plan.json";

function readLisaPlan(dir: string): ExecutionPlan | null {
	const planPath = join(dir, PLAN_FILE);
	if (!existsSync(planPath)) return null;
	try {
		return JSON.parse(readFileSync(planPath, "utf-8").trim()) as ExecutionPlan;
	} catch {
		return null;
	}
}

function cleanupPlan(dir: string): void {
	try {
		unlinkSync(join(dir, PLAN_FILE));
	} catch {}
}

const MANIFEST_FILE = ".lisa-manifest.json";

interface LisaManifest {
	repoPath?: string;
	branch?: string;
	prUrl?: string;
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
		`Starting loop (models: ${models.map((m) => (m.model ? `${m.provider}/${m.model}` : m.provider)).join(" → ")}, source: ${config.source}, label: ${config.source_config.label}, workflow: ${config.workflow})`,
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
			logger.log(
				`[dry-run] Models priority: ${models.map((m) => (m.model ? `${m.provider}/${m.model}` : m.provider)).join(" → ")}`,
			);
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

			// If every provider failed due to infrastructure issues (quota, plan limits,
			// binary not found) rather than task content, retrying won't help — stop the
			// loop so the user can fix their provider configuration.
			if (isCompleteProviderExhaustion(sessionResult.fallback.attempts)) {
				logger.error(
					"All providers exhausted due to infrastructure issues (quota, plan limits, or not installed). " +
						"Fix your provider configuration and restart lisa.",
				);
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
	providerUsed: string;
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

async function findWorktreeForBranch(repoRoot: string, branch: string): Promise<string | null> {
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

async function runWorktreeSession(
	config: LisaConfig,
	issue: { id: string; title: string; url: string; description: string; repo?: string },
	logFile: string,
	session: number,
	models: ModelSpec[],
): Promise<SessionResult> {
	// Multi-repo: delegate to planning + sequential sessions
	if (config.repos.length > 1) {
		return runWorktreeMultiRepoSession(config, issue, logFile, session, models);
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
		);
	}

	return runManualWorktreeSession(config, issue, logFile, session, models, repoPath, defaultBranch);
}

async function runNativeWorktreeSession(
	config: LisaConfig,
	issue: { id: string; title: string; url: string; description: string; repo?: string },
	logFile: string,
	session: number,
	models: ModelSpec[],
	repoPath: string,
	_defaultBranch: string,
): Promise<SessionResult> {
	const failResult = (providerUsed: string, fallback?: FallbackResult): SessionResult => ({
		success: false,
		providerUsed,
		prUrls: [],
		fallback: fallback ?? { success: false, output: "", duration: 0, providerUsed, attempts: [] },
	});

	// Start lifecycle resources before implementation
	const repo = findRepoConfig(config, issue);
	if (repo?.lifecycle) {
		startSpinner(`${issue.id} \u2014 starting resources...`);
		const started = await startResources(repo, repoPath);
		stopSpinner();
		if (!started) {
			logger.error(`Lifecycle startup failed for ${issue.id}. Aborting session.`);
			return failResult(models[0]?.provider ?? "claude");
		}
	}

	const testRunner = detectTestRunner(repoPath);
	if (testRunner) logger.log(`Detected test runner: ${testRunner}`);
	const pm = detectPackageManager(repoPath);

	// Clean stale manifest from previous run
	cleanupManifest(repoPath);

	const prompt = buildNativeWorktreePrompt(issue, repoPath, testRunner, pm, _defaultBranch);
	startSpinner(`${issue.id} \u2014 implementing (native worktree)...`);
	logger.log(`Implementing with native worktree... (log: ${logFile})`);
	logger.initLogFile(logFile);

	const result = await runWithFallback(models, prompt, {
		logFile,
		cwd: repoPath,
		guardrailsDir: repoPath,
		issueId: issue.id,
		overseer: config.overseer,
		useNativeWorktree: true,
	});
	stopSpinner();

	try {
		appendFileSync(
			logFile,
			`\n${"=".repeat(80)}\nProvider used: ${result.providerUsed}\nFull output:\n${result.output}\n`,
		);
	} catch {}

	if (repo?.lifecycle) await stopResources();

	if (!result.success) {
		logger.error(`Session ${session} failed for ${issue.id}. Check ${logFile}`);
		cleanupManifest(repoPath);
		return { success: false, providerUsed: result.providerUsed, prUrls: [], fallback: result };
	}

	const manifest = readLisaManifest(repoPath);
	cleanupManifest(repoPath);

	if (!manifest?.prUrl) {
		logger.error(
			`Agent did not produce a .lisa-manifest.json with prUrl for ${issue.id}. Aborting.`,
		);
		const worktreePath = manifest?.branch
			? await findWorktreeForBranch(repoPath, manifest.branch)
			: null;
		if (worktreePath) await cleanupWorktree(repoPath, worktreePath);
		return { success: false, providerUsed: result.providerUsed, prUrls: [], fallback: result };
	}

	const worktreePath = await findWorktreeForBranch(repoPath, manifest.branch ?? "");
	logger.ok(`PR created by provider: ${manifest.prUrl}`);
	if (worktreePath) await cleanupWorktree(repoPath, worktreePath);

	logger.ok(`Session ${session} complete for ${issue.id}`);
	return {
		success: true,
		providerUsed: result.providerUsed,
		prUrls: [manifest.prUrl],
		fallback: result,
	};
}

async function runManualWorktreeSession(
	config: LisaConfig,
	issue: { id: string; title: string; url: string; description: string; repo?: string },
	logFile: string,
	session: number,
	models: ModelSpec[],
	repoPath: string,
	defaultBranch: string,
): Promise<SessionResult> {
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
	}

	// Detect test runner for prompt enhancement
	const testRunner = detectTestRunner(worktreePath);
	if (testRunner) {
		logger.log(`Detected test runner: ${testRunner}`);
	}
	const pm = detectPackageManager(worktreePath);

	const prompt = buildImplementPrompt(issue, config, testRunner, pm);
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

	// Read manifest written by agent
	const manifest = readLisaManifest(worktreePath);
	cleanupManifest(worktreePath);

	if (!manifest?.prUrl) {
		logger.error(
			`Agent did not produce a .lisa-manifest.json with prUrl for ${issue.id}. Aborting.`,
		);
		await cleanupWorktree(repoPath, worktreePath);
		return { success: false, providerUsed: result.providerUsed, prUrls: [], fallback: result };
	}

	logger.ok(`PR created by provider: ${manifest.prUrl}`);
	await cleanupWorktree(repoPath, worktreePath);

	logger.ok(`Session ${session} complete for ${issue.id}`);
	return {
		success: true,
		providerUsed: result.providerUsed,
		prUrls: [manifest.prUrl],
		fallback: result,
	};
}

async function runWorktreeMultiRepoSession(
	config: LisaConfig,
	issue: { id: string; title: string; url: string; description: string; repo?: string },
	logFile: string,
	session: number,
	models: ModelSpec[],
): Promise<SessionResult> {
	const workspace = resolve(config.workspace);

	// Clean stale artifacts from previous interrupted runs
	cleanupManifest(workspace);
	cleanupPlan(workspace);

	// Phase 1: Planning — agent analyzes issue and produces execution plan
	startSpinner(`${issue.id} \u2014 analyzing issue...`);
	logger.log(`Multi-repo planning phase for ${issue.id}`);
	logger.initLogFile(logFile);

	const planPrompt = buildPlanningPrompt(issue, config);
	const planResult = await runWithFallback(models, planPrompt, {
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
			`\n${"=".repeat(80)}\nPlanning phase — provider: ${planResult.providerUsed}\n${planResult.output}\n`,
		);
	} catch {}

	if (!planResult.success) {
		logger.error(`Planning phase failed for ${issue.id}. Check ${logFile}`);
		cleanupPlan(workspace);
		return {
			success: false,
			providerUsed: planResult.providerUsed,
			prUrls: [],
			fallback: planResult,
		};
	}

	// Read execution plan
	const plan = readLisaPlan(workspace);
	if (!plan?.steps || plan.steps.length === 0) {
		logger.error(`Agent did not produce a valid .lisa-plan.json for ${issue.id}. Aborting.`);
		cleanupPlan(workspace);
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
	cleanupPlan(workspace);

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

	logger.ok(`Session ${session} complete for ${issue.id} — ${prUrls.length} PR(s) created`);
	return { success: true, providerUsed: lastProvider, prUrls, fallback: lastFallback };
}

interface MultiRepoStepResult {
	success: boolean;
	providerUsed: string;
	branch: string;
	prUrl?: string;
	fallback: FallbackResult;
}

async function runMultiRepoStep(
	config: LisaConfig,
	issue: { id: string; title: string; url: string; description: string },
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
		worktreePath = await createWorktree(repoPath, branchName, defaultBranch);
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

	// Start lifecycle resources for this repo step
	const repoConfig = config.repos.find((r) => resolve(config.workspace, r.path) === step.repoPath);
	if (repoConfig?.lifecycle) {
		startSpinner(`${issue.id} step ${stepNum} \u2014 starting resources...`);
		const started = await startResources(repoConfig, worktreePath);
		stopSpinner();
		if (!started) {
			logger.error(`Lifecycle startup failed for step ${stepNum}. Aborting.`);
			await cleanupWorktree(repoPath, worktreePath);
			return failResult(models[0]?.provider ?? "claude");
		}
	}

	// Run scoped implementation
	const prompt = buildScopedImplementPrompt(
		issue,
		step,
		previousResults,
		testRunner,
		pm,
		isLastStep,
		defaultBranch,
	);
	startSpinner(`${issue.id} step ${stepNum} \u2014 implementing...`);

	const result = await runWithFallback(models, prompt, {
		logFile,
		cwd: worktreePath,
		guardrailsDir: repoPath,
		issueId: issue.id,
		overseer: config.overseer,
	});
	stopSpinner();

	// Stop lifecycle resources after implementation
	if (repoConfig?.lifecycle) await stopResources();

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

	const manifest = readLisaManifest(worktreePath);
	cleanupManifest(worktreePath);

	if (!manifest?.prUrl) {
		logger.error(`Agent did not produce a .lisa-manifest.json with prUrl for step ${stepNum}.`);
		await cleanupWorktree(repoPath, worktreePath);
		return { ...failResult(result.providerUsed, result), branch: branchName };
	}

	await cleanupWorktree(repoPath, worktreePath);

	logger.ok(`Step ${stepNum} complete: ${repoPath} — PR: ${manifest.prUrl}`);
	return {
		success: true,
		providerUsed: result.providerUsed,
		branch: manifest.branch ?? branchName,
		prUrl: manifest.prUrl,
		fallback: result,
	};
}

async function runBranchSession(
	config: LisaConfig,
	issue: { id: string; title: string; url: string; description: string; repo?: string },
	logFile: string,
	session: number,
	models: ModelSpec[],
): Promise<SessionResult> {
	const workspace = resolve(config.workspace);

	// Clean any stale manifest from a previous interrupted run
	cleanupManifest(workspace);

	// Detect test runner for prompt enhancement
	const testRunner = detectTestRunner(workspace);
	if (testRunner) {
		logger.log(`Detected test runner: ${testRunner}`);
	}
	const pm = detectPackageManager(workspace);

	const prompt = buildImplementPrompt(issue, config, testRunner, pm);

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

	const manifest = readLisaManifest(workspace);
	cleanupManifest(workspace);

	if (!manifest?.prUrl) {
		logger.error(`Agent did not produce a .lisa-manifest.json with prUrl for ${issue.id}.`);
		return { success: false, providerUsed: result.providerUsed, prUrls: [], fallback: result };
	}

	logger.ok(`PR created by provider: ${manifest.prUrl}`);
	logger.ok(`Session ${session} complete for ${issue.id}`);
	return {
		success: true,
		providerUsed: result.providerUsed,
		prUrls: [manifest.prUrl],
		fallback: result,
	};
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
