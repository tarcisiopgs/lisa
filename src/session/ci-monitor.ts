import { execa } from "execa";
import { formatError } from "../errors.js";
import * as logger from "../output/logger.js";
import { startSpinner, stopSpinner } from "../output/terminal.js";
import { runWithFallback } from "../providers/index.js";
import type { CiMonitorConfig, Issue, LisaConfig, ModelSpec, RunOptions } from "../types/index.js";
import { kanbanEmitter } from "../ui/state.js";

export interface CiMonitorResult {
	passed: boolean;
	skipped: boolean;
	attempts: number;
}

type CiStatus = "pending" | "success" | "failure" | "not_found";

interface CiRun {
	status: CiStatus;
	id: string;
	name: string;
	url: string;
}

async function pollGitHubCi(branch: string, cwd: string): Promise<CiRun | null> {
	try {
		const { stdout } = await execa(
			"gh",
			[
				"run",
				"list",
				"--branch",
				branch,
				"--limit",
				"1",
				"--json",
				"databaseId,status,conclusion,name,url",
			],
			{ cwd, timeout: 15_000 },
		);
		const runs = JSON.parse(stdout) as {
			databaseId: number;
			status: string;
			conclusion: string | null;
			name: string;
			url: string;
		}[];

		if (runs.length === 0) return null;

		const run = runs[0]!;
		let ciStatus: CiStatus;

		if (run.status === "completed") {
			ciStatus = run.conclusion === "success" ? "success" : "failure";
		} else {
			ciStatus = "pending";
		}

		return {
			status: ciStatus,
			id: String(run.databaseId),
			name: run.name,
			url: run.url,
		};
	} catch {
		return null;
	}
}

async function extractGitHubCiLogs(runId: string, cwd: string): Promise<string> {
	try {
		const { stdout } = await execa("gh", ["run", "view", runId, "--log-failed"], {
			cwd,
			timeout: 30_000,
		});
		// Truncate to last 200 lines to avoid overwhelming the prompt
		const lines = stdout.split("\n");
		return lines.length > 200 ? lines.slice(-200).join("\n") : stdout;
	} catch (err) {
		return `Failed to extract CI logs: ${formatError(err)}`;
	}
}

function buildCiRecoveryPrompt(issue: Issue, ciLogs: string, branch: string): string {
	return `You are an autonomous implementation agent fixing CI failures.
A pull request was created for the issue below, but the CI pipeline failed.
You MUST fix the errors and push the fix. Do NOT create a new PR — push to the existing branch.
Do NOT use interactive skills, ask clarifying questions, or wait for user input. You are running unattended.

## Issue

- **ID:** ${issue.id}
- **Title:** ${issue.title}

## CI Failure Logs

\`\`\`
${ciLogs}
\`\`\`

## Instructions

1. **Analyze the CI failure logs** above carefully. Identify the root cause of each failure.
2. **Fix the issues** in the source code. Common failures include:
   - Linter errors → fix code style
   - Type errors → fix types
   - Test failures → fix test or implementation
   - Build errors → fix imports, dependencies, or configuration
3. **Commit the fix** with a conventional commit message: \`fix: resolve CI failures\`
4. **Push to the existing branch**: \`git push origin ${branch}\`
   If push is rejected, pull first: \`git pull --rebase origin ${branch}\` then push again.
   Do NOT use \`--force\` unless rebasing creates conflicts.

## Rules

- All commits and messages MUST be in English.
- Do NOT create a new branch or a new PR.
- Do NOT install new dependencies unless the error explicitly requires it.
- Fix only what the CI logs indicate — do not refactor unrelated code.
- One fix at a time. If there are multiple errors, fix them all in a single commit.`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isCiMonitorEnabled(config?: CiMonitorConfig): boolean {
	return config?.enabled === true;
}

export async function monitorCi(
	branch: string,
	config: LisaConfig,
	issue: Issue,
	models: ModelSpec[],
	cwd: string,
	logFile: string,
	workspace: string,
	lifecycleEnv: Record<string, string>,
	buildRunOpts: (extra?: Partial<RunOptions>) => RunOptions,
): Promise<CiMonitorResult> {
	const ciConfig = config.ci_monitor;
	if (!isCiMonitorEnabled(ciConfig)) {
		return { passed: true, skipped: true, attempts: 0 };
	}

	// Only GitHub is supported for now
	const platform = config.platform;
	if (platform !== "cli" && platform !== "token") {
		logger.log("CI monitoring is only supported for GitHub platforms. Skipping.");
		return { passed: true, skipped: true, attempts: 0 };
	}

	const maxRetries = ciConfig?.max_retries ?? 3;
	const pollInterval = (ciConfig?.poll_interval ?? 30) * 1000;
	const pollTimeout = (ciConfig?.poll_timeout ?? 600) * 1000;
	let retriesLeft = maxRetries;

	while (true) {
		startSpinner(`${issue.id} — waiting for CI...`);
		kanbanEmitter.emit("issue:ci-status", issue.id, "pending");
		const startTime = Date.now();
		let lastRun: CiRun | null = null;

		// Poll until CI completes or timeout
		while (Date.now() - startTime < pollTimeout) {
			lastRun = await pollGitHubCi(branch, cwd);

			if (!lastRun) {
				// No CI runs found — maybe no workflows configured
				logger.log("No CI runs found for this branch. Skipping CI monitor.");
				stopSpinner();
				return { passed: true, skipped: true, attempts: 0 };
			}

			if (lastRun.status === "success") {
				stopSpinner();
				kanbanEmitter.emit("issue:ci-status", issue.id, "passing");
				logger.ok(`CI passed: ${lastRun.name}`);
				return { passed: true, skipped: false, attempts: maxRetries - retriesLeft };
			}

			if (lastRun.status === "failure") {
				kanbanEmitter.emit("issue:ci-status", issue.id, "failing");
				break; // Exit poll loop to handle failure
			}

			// Still pending — wait and poll again
			await sleep(pollInterval);
		}

		stopSpinner();

		if (!lastRun || lastRun.status === "pending") {
			logger.warn(`CI did not complete within ${ciConfig?.poll_timeout ?? 600}s. Skipping.`);
			return { passed: false, skipped: false, attempts: maxRetries - retriesLeft };
		}

		// CI failed
		if (retriesLeft <= 0) {
			logger.error(`CI failed after ${maxRetries} fix attempts for ${issue.id}.`);
			return { passed: false, skipped: false, attempts: maxRetries };
		}

		retriesLeft--;
		logger.warn(
			`CI failed for ${issue.id} (${retriesLeft} retries left). Extracting logs and re-invoking agent...`,
		);

		// Extract failed logs
		const ciLogs = await extractGitHubCiLogs(lastRun.id, cwd);

		// Build recovery prompt and re-invoke provider
		const recoveryPrompt = buildCiRecoveryPrompt(issue, ciLogs, branch);
		startSpinner(`${issue.id} — fixing CI failures...`);
		const recoveryResult = await runWithFallback(models, recoveryPrompt, buildRunOpts());
		stopSpinner();

		if (!recoveryResult.success) {
			logger.error(`CI recovery attempt failed for ${issue.id}.`);
			return { passed: false, skipped: false, attempts: maxRetries - retriesLeft };
		}

		logger.ok("CI fix pushed. Waiting for new CI run...");
		// Brief delay to let the new push trigger a CI run
		await sleep(5000);
	}
}
