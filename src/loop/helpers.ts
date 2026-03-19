import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { execa } from "execa";
import { formatError } from "../errors.js";
import * as logger from "../output/logger.js";
import { startSpinner, stopSpinner } from "../output/terminal.js";
import { runWithFallback } from "../providers/index.js";
import { discoverInfra } from "../session/discovery.js";
import { runLifecycle, stopResources } from "../session/lifecycle.js";
import {
	buildValidationRecoveryPrompt,
	isProofOfWorkEnabled,
	runValidationCommands,
} from "../session/proof-of-work.js";
import { startReconciliation } from "../session/reconciliation.js";
import type {
	FallbackResult,
	Issue,
	LisaConfig,
	ModelSpec,
	RunOptions,
	Source,
	ValidationResult,
} from "../types/index.js";
import type { SessionResult } from "./result.js";
import {
	activeProviderPids,
	isLoopPaused,
	reconciliationSet,
	userKilledSet,
	userSkippedSet,
} from "./state.js";

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

export async function waitIfPaused(): Promise<void> {
	while (isLoopPaused()) {
		await sleep(500);
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
	extra?: Partial<RunOptions>,
): RunOptions {
	return {
		logFile,
		cwd,
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
		...extra,
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
	result: FallbackResult,
): Promise<{ results?: ValidationResult[]; reconciled?: boolean }> {
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
			logger.error(`Validation recovery failed for ${issue.id}. Creating PR with failures noted.`);
			return { results };
		}
	}
}
