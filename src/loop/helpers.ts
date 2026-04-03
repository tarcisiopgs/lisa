import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { execa } from "execa";
import { formatError } from "../errors.js";
import * as logger from "../output/logger.js";
import { startSpinner, stopSpinner } from "../output/terminal.js";
import { runWithFallback } from "../providers/index.js";
import { discoverInfra } from "../session/discovery.js";
import { runLifecycle } from "../session/lifecycle.js";
import {
	buildValidationRecoveryPrompt,
	isProofOfWorkEnabled,
	runValidationCommands,
} from "../session/proof-of-work.js";
import { startReconciliation } from "../session/reconciliation.js";
import {
	buildCompliancePrompt,
	buildComplianceRecoveryPrompt,
	extractAcceptanceCriteria,
	getFullDiff,
	isSpecComplianceEnabled,
	parseComplianceResponse,
} from "../session/spec-compliance.js";
import type {
	FallbackResult,
	Issue,
	LisaConfig,
	ModelSpec,
	RunOptions,
	Source,
	SpecComplianceResult,
	ValidationResult,
} from "../types/index.js";
import { kanbanEmitter } from "../ui/state.js";
import { validateIssueSpec } from "../validation.js";
import type { SessionResult } from "./result.js";
import {
	activeProviderPids,
	hasUserQuitFromWatchPrompt,
	isLoopPaused,
	isShuttingDown,
	reconciliationSet,
	userKilledSet,
	userSkippedSet,
} from "./state.js";

// ── Shared issue processing helpers ─────────────────────────────────────

/**
 * Validate issue spec and add "needs-spec" label if validation fails.
 * Returns true if the issue is valid (or validation is disabled), false otherwise.
 * When false, the issue is annotated with `specWarning` but NOT skipped — callers
 * decide control flow.
 */
export async function checkIssueSpec(
	issue: Issue,
	config: LisaConfig,
	source: Source,
): Promise<boolean> {
	const specResult = validateIssueSpec(issue, config.validation);
	if (!specResult.valid) {
		logger.warn(`Issue ${issue.id}: ${specResult.reason} — proceeding with incomplete spec`);
		try {
			await source.addLabel?.(issue.id, "needs-spec");
			logger.ok(`Added label "needs-spec" to ${issue.id}`);
		} catch (err) {
			logger.warn(`Failed to add label "needs-spec": ${formatError(err)}`);
		}
		issue.specWarning = specResult.reason;
		return false;
	}
	return true;
}

/** Move an issue to the in_progress status. Logs on failure but does not throw. */
export async function moveToInProgress(
	issue: Issue,
	source: Source,
	config: LisaConfig,
): Promise<void> {
	try {
		await source.updateStatus(issue.id, config.source_config.in_progress, config.source_config);
		logger.ok(`Moved ${issue.id} to "${config.source_config.in_progress}"`);
	} catch (err) {
		logger.warn(`Failed to update status: ${formatError(err)}`);
	}
}

/** Revert an issue back to its previous status (typically pick_from). Logs on failure. */
export async function revertIssueStatus(
	issue: Issue,
	source: Source,
	config: LisaConfig,
): Promise<void> {
	const previousStatus = config.source_config.pick_from;
	try {
		await source.updateStatus(issue.id, previousStatus, config.source_config);
		logger.ok(`Reverted ${issue.id} to "${previousStatus}"`);
	} catch (revertErr) {
		logger.error(`Failed to revert status: ${formatError(revertErr)}`);
	}
}

export function resolveProviderOptions(config: LisaConfig): { effort?: string } | undefined {
	const opts = config.provider_options?.[config.provider];
	if (!opts?.effort) return undefined;
	return { effort: opts.effort };
}

export function resolveBaseBranch(config: LisaConfig, repoPath: string): string {
	const workspace = resolve(config.workspace);
	const repo = config.repos.find((r) => resolve(workspace, r.path) === repoPath);
	return repo?.base_branch ?? config.base_branch;
}

export async function checkoutBaseBranches(config: LisaConfig, workspace: string): Promise<void> {
	const targets: { cwd: string; branch: string }[] = [
		{ cwd: workspace, branch: config.base_branch },
		...config.repos.map((r) => ({
			cwd: resolve(workspace, r.path),
			branch: r.base_branch,
		})),
	];

	for (const { cwd, branch } of targets) {
		try {
			await execa("git", ["checkout", branch], { cwd });
			logger.ok(`Checked out ${branch} in ${cwd}`);
		} catch (err) {
			logger.warn(`Could not checkout ${branch} in ${cwd}: ${formatError(err)}`);
		}
	}
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sleep that can be interrupted by shutdown or quit signals.
 * Polls every second instead of blocking for the full duration.
 */
export async function interruptibleSleep(ms: number): Promise<void> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (isShuttingDown() || hasUserQuitFromWatchPrompt()) return;
		await sleep(Math.min(1000, end - Date.now()));
	}
}

export async function waitIfPaused(): Promise<void> {
	while (isLoopPaused()) {
		await sleep(500);
	}
}

/** Re-fetch issues from source and populate the kanban backlog. */
export async function refreshKanban(source: Source, config: LisaConfig): Promise<void> {
	if (kanbanEmitter.listenerCount("issue:queued") === 0) return;
	try {
		const allIssues = await source.listIssues(config.source_config);
		for (const issue of allIssues) {
			kanbanEmitter.emit("issue:queued", issue);
		}
		// Remove stale backlog cards that are no longer in the source
		const sourceIds = new Set(allIssues.map((i) => i.id));
		kanbanEmitter.emit("kanban:reconcile-backlog", sourceIds);
	} catch {
		// Non-fatal
	}
}

// ── Shared session helpers ──────────────────────────────────────────────

/** Default provider name from model specs, used in failure results. */
export function defaultProvider(models: ModelSpec[]): string {
	return models[0]?.provider ?? "claude";
}

/** Build a failure SessionResult with no PRs. */
export function failureResult(providerUsed: string, fallback: FallbackResult): SessionResult {
	return { success: false, providerUsed, prUrls: [], fallback };
}

/** Build a failure FallbackResult for hooks/worktree errors. */
export function hookFailure(providerUsed: string, message: string): SessionResult {
	return failureResult(providerUsed, {
		success: false,
		output: message,
		duration: 0,
		providerUsed,
		attempts: [],
	});
}

/** Build the "provider succeeded but no code changes" failure result. */
export function emptyCommitFailure(result: FallbackResult): SessionResult {
	logger.error("Provider reported success but no code changes detected. Treating as failure.");
	return failureResult(result.providerUsed, {
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
	});
}

/**
 * Pull the latest changes from the base branch in the workspace and all
 * configured sub-repos. Runs before each session so the agent always works
 * on up-to-date code. Best-effort — failures are logged but do not block
 * the session.
 */
export async function pullBaseBranch(config: LisaConfig): Promise<void> {
	const workspace = resolve(config.workspace);
	const baseBranch = config.base_branch;

	// Only pull in sub-repos when configured; skip the root workspace
	// since multi-repo setups typically have the root as a plain directory
	// (not a git repo) with sub-repos inside.
	const repoPaths: string[] = [];
	if (config.repos.length > 0) {
		for (const repo of config.repos) {
			repoPaths.push(resolve(workspace, repo.path));
		}
	} else {
		repoPaths.push(workspace);
	}

	for (const repoPath of repoPaths) {
		try {
			// Ensure we're on the base branch before pulling
			await execa("git", ["checkout", baseBranch], {
				cwd: repoPath,
				reject: true,
				timeout: 15_000,
			});
			await execa("git", ["pull", "--ff-only", "origin", baseBranch], {
				cwd: repoPath,
				reject: true,
				timeout: 30_000,
			});
		} catch {
			// ff-only may fail if the local branch diverged (e.g. agent committed
			// directly on main in branch workflow). Reset to match remote.
			try {
				await execa("git", ["fetch", "origin", baseBranch], {
					cwd: repoPath,
					reject: true,
					timeout: 30_000,
				});
				await execa("git", ["reset", "--hard", `origin/${baseBranch}`], {
					cwd: repoPath,
					reject: true,
					timeout: 15_000,
				});
			} catch (err) {
				logger.warn(`Failed to pull ${baseBranch} in ${repoPath}: ${formatError(err)}`);
			}
		}
	}
}

/**
 * Auto-merge a PR after the session completes successfully.
 * Merges the PR, emits the merged event (which triggers pullBaseBranch),
 * and logs the result. Best-effort — merge failures are logged but do not
 * fail the session.
 */
export async function autoMergePr(
	prUrl: string,
	issueId: string,
	config: LisaConfig,
): Promise<void> {
	if (!config.pr?.auto_merge) return;

	logger.log(`Auto-merging PR for ${issueId}...`);
	const { mergePr } = await import("../git/merge.js");
	const result = await mergePr(prUrl);
	if (result.success) {
		logger.ok(`Auto-merged: ${prUrl}`);
		kanbanEmitter.emit("issue:merged", issueId);
	} else {
		logger.warn(`Auto-merge failed for ${issueId}: ${result.error}`);
	}
}

/** Append session summary to log file (best-effort, ignores errors). */
export function appendSessionLog(logFile: string, result: FallbackResult): void {
	try {
		appendFileSync(
			logFile,
			`\n${"=".repeat(80)}\nProvider used: ${result.providerUsed}\nFull output:\n${result.output}\n`,
		);
	} catch {
		/* non-fatal: log write failure */
	}
}

/** Check if issue was reconciled and return early result if so. */
export function checkReconciliation(issueId: string, result: FallbackResult): SessionResult | null {
	if (reconciliationSet.has(issueId)) {
		reconciliationSet.delete(issueId);
		logger.warn(`Issue ${issueId} was closed/cancelled externally. Skipping.`);
		return failureResult(result.providerUsed, result);
	}
	return null;
}

/** Build RunOptions for provider invocation. */
export function buildRunOptions(
	config: LisaConfig,
	issue: Issue,
	cwd: string,
	logFile: string,
	workspace: string,
	lifecycleEnv: Record<string, string>,
	extra?: Partial<RunOptions> & { slotIndex?: number },
): RunOptions {
	const portEnv: Record<string, string> = {};
	if (extra?.slotIndex !== undefined) {
		portEnv.LISA_PORT_BASE = String(3000 + extra.slotIndex * 10);
		portEnv.LISA_SLOT_INDEX = String(extra.slotIndex);
	}

	const { slotIndex: _slotIndex, ...restExtra } = extra ?? {};
	const mergedEnv =
		Object.keys(lifecycleEnv).length > 0 || Object.keys(portEnv).length > 0
			? { ...lifecycleEnv, ...portEnv }
			: undefined;

	return {
		logFile,
		cwd,
		guardrailsDir: workspace,
		issueId: issue.id,
		overseer: config.overseer,
		sessionTimeout: config.loop.session_timeout,
		outputStallTimeout: config.loop.output_stall_timeout,
		providerOptions: resolveProviderOptions(config),
		env: mergedEnv,
		onProcess: (pid) => {
			activeProviderPids.set(issue.id, pid);
		},
		shouldAbort: () => userKilledSet.has(issue.id) || userSkippedSet.has(issue.id),
		...restExtra,
	};
}

/** Discover infrastructure and start lifecycle resources. Returns env vars from started resources. */
export async function startInfra(
	issueId: string,
	cwd: string,
	config: LisaConfig,
): Promise<Record<string, string>> {
	const infra = discoverInfra(cwd);
	if (!infra) return {};

	startSpinner(`${issueId} \u2014 starting resources...`);
	const started = await runLifecycle(infra, config.lifecycle, cwd);
	stopSpinner();
	if (!started.success) {
		logger.warn(
			`Lifecycle startup failed for ${issueId}. Continuing with manual resource instructions.`,
		);
	}
	return started.env;
}

/** Start reconciliation monitor if configured. */
export function startReconciliationMonitor(
	source: Source | undefined,
	issueId: string,
	config: LisaConfig,
) {
	return source && config.reconciliation?.enabled
		? startReconciliation(source, issueId, config.reconciliation, config.source_config)
		: null;
}

/** Run proof-of-work validation loop. Returns validation results or undefined. */
export async function runProofOfWork(
	config: LisaConfig,
	issue: Issue,
	models: ModelSpec[],
	cwd: string,
	logFile: string,
	workspace: string,
	lifecycleEnv: Record<string, string>,
	_result: FallbackResult,
): Promise<{ results?: ValidationResult[]; reconciled?: boolean; blocked?: boolean }> {
	if (!isProofOfWorkEnabled(config.proof_of_work)) return {};

	const pow = config.proof_of_work;
	let retriesLeft = pow?.max_retries ?? 2;

	while (true) {
		if (reconciliationSet.has(issue.id)) {
			reconciliationSet.delete(issue.id);
			logger.warn(`Issue ${issue.id} was closed/cancelled during validation. Skipping.`);
			return { reconciled: true };
		}

		startSpinner(`${issue.id} \u2014 validating...`);
		const results = await runValidationCommands(pow?.commands ?? [], cwd, pow?.timeout);
		stopSpinner();

		const failures = results.filter((r) => !r.success);

		if (failures.length === 0) {
			logger.ok(`All validation checks passed for ${issue.id}`);
			return { results };
		}

		if (retriesLeft <= 0) {
			if (pow?.block_on_failure) {
				logger.error(
					`Validation failed after max retries for ${issue.id}. Blocking PR creation (block_on_failure=true).`,
				);
				return { results, blocked: true };
			}
			logger.error(
				`Validation failed after max retries for ${issue.id}. Creating PR with failures noted.`,
			);
			return { results };
		}

		retriesLeft--;
		logger.warn(
			`Validation failed for ${issue.id} (${retriesLeft} retries left). Re-invoking agent...`,
		);

		const recoveryPrompt = buildValidationRecoveryPrompt(issue, failures);
		startSpinner(`${issue.id} \u2014 fixing validation failures...`);
		const recoveryResult = await runWithFallback(
			models,
			recoveryPrompt,
			buildRunOptions(config, issue, cwd, logFile, workspace, lifecycleEnv),
		);
		stopSpinner();

		if (!recoveryResult.success) {
			if (pow?.block_on_failure) {
				logger.error(
					`Validation recovery failed for ${issue.id}. Blocking PR creation (block_on_failure=true).`,
				);
				return { results, blocked: true };
			}
			logger.error(`Validation recovery failed for ${issue.id}. Creating PR with failures noted.`);
			return { results };
		}
	}
}

/** Run spec compliance check: verify implementation satisfies acceptance criteria via LLM. */
export async function runSpecCompliance(
	config: LisaConfig,
	issue: Issue,
	models: ModelSpec[],
	cwd: string,
	baseBranch: string,
	logFile: string,
	workspace: string,
	lifecycleEnv: Record<string, string>,
): Promise<{ result?: SpecComplianceResult; reconciled?: boolean; blocked?: boolean }> {
	if (!isSpecComplianceEnabled(config.spec_compliance)) return {};

	const criteria = extractAcceptanceCriteria(issue.description);
	if (criteria.length === 0) {
		logger.warn(`No extractable acceptance criteria for ${issue.id}. Skipping spec compliance.`);
		return {};
	}

	const sc = config.spec_compliance;
	let retriesLeft = sc?.max_retries ?? 1;

	while (true) {
		if (reconciliationSet.has(issue.id)) {
			reconciliationSet.delete(issue.id);
			logger.warn(`Issue ${issue.id} was closed/cancelled during spec compliance. Skipping.`);
			return { reconciled: true };
		}

		startSpinner(`${issue.id} \u2014 checking spec compliance...`);
		const diff = await getFullDiff(cwd, baseBranch);
		if (!diff) {
			stopSpinner();
			logger.warn(`No diff available for spec compliance on ${issue.id}. Skipping.`);
			return {};
		}

		const compliancePrompt = buildCompliancePrompt(issue, criteria, diff);
		const checkResult = await runWithFallback(
			models,
			compliancePrompt,
			buildRunOptions(config, issue, cwd, logFile, workspace, lifecycleEnv),
		);
		stopSpinner();

		if (!checkResult.success) {
			logger.warn(`Spec compliance check failed to run for ${issue.id}. Proceeding without it.`);
			return {};
		}

		const compliance = parseComplianceResponse(checkResult.output);
		if (!compliance) {
			logger.warn(
				`Could not parse spec compliance response for ${issue.id}. Proceeding without it.`,
			);
			return {};
		}

		if (compliance.passed) {
			logger.ok(`Spec compliance passed for ${issue.id}: ${compliance.summary}`);
			return { result: compliance };
		}

		// Some criteria not met
		const unmet = compliance.criteria.filter((c) => !c.met);
		logger.warn(
			`Spec compliance failed for ${issue.id}: ${compliance.summary} (${unmet.length} unmet)`,
		);

		if (retriesLeft <= 0) {
			if (sc?.block_on_failure) {
				logger.error(
					`Spec compliance failed after max retries for ${issue.id}. Blocking PR creation.`,
				);
				return { result: compliance, blocked: true };
			}
			logger.warn(
				`Spec compliance failed after max retries for ${issue.id}. Creating PR with failures noted.`,
			);
			return { result: compliance };
		}

		retriesLeft--;
		logger.warn(
			`Re-invoking agent to fix unmet criteria for ${issue.id} (${retriesLeft} retries left)...`,
		);

		const recoveryPrompt = buildComplianceRecoveryPrompt(issue, unmet);
		startSpinner(`${issue.id} \u2014 fixing unmet criteria...`);
		const recoveryResult = await runWithFallback(
			models,
			recoveryPrompt,
			buildRunOptions(config, issue, cwd, logFile, workspace, lifecycleEnv),
		);
		stopSpinner();

		if (!recoveryResult.success) {
			if (sc?.block_on_failure) {
				logger.error(`Spec compliance recovery failed for ${issue.id}. Blocking PR creation.`);
				return { result: compliance, blocked: true };
			}
			logger.warn(
				`Spec compliance recovery failed for ${issue.id}. Creating PR with failures noted.`,
			);
			return { result: compliance };
		}
	}
}
