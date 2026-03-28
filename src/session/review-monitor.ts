import { createHash } from "node:crypto";
import { execa } from "execa";
import { formatError } from "../errors.js";
import * as logger from "../output/logger.js";
import { startSpinner, stopSpinner } from "../output/terminal.js";
import { runWithFallback } from "../providers/index.js";
import type {
	Issue,
	LisaConfig,
	ModelSpec,
	ReviewComment,
	ReviewMonitorConfig,
	RunOptions,
	SessionState,
} from "../types/index.js";
import { executeNotify, resolveReaction, shouldEscalate } from "./reactions.js";
import { loadSessionRecord, updateSessionState } from "./state.js";

export interface ReviewMonitorResult {
	finalState: SessionState;
	attempts: number;
}

export function isReviewMonitorEnabled(config?: ReviewMonitorConfig): boolean {
	return config?.enabled === true;
}

export function parseReviewDecision(
	decision: string | undefined,
): "approved" | "changes_requested" | "review_pending" {
	if (decision === "APPROVED") return "approved";
	if (decision === "CHANGES_REQUESTED") return "changes_requested";
	return "review_pending";
}

export function buildReviewFingerprint(comments: ReviewComment[]): string {
	if (comments.length === 0) return "";
	const sortedIds = [...comments.map((c) => c.id)].sort();
	const joined = sortedIds.join(",");
	return createHash("sha256").update(joined).digest("hex").slice(0, 16);
}

export function buildReviewRecoveryPrompt(
	issue: { id: string; title: string },
	comments: ReviewComment[],
	branch: string,
): string {
	const commentSections = comments
		.map((c) => {
			const location = c.path ? `**File:** \`${c.path}\`:${c.line}` : "**General comment**";
			return `### ${c.author}\n${location}\n\n${c.body}`;
		})
		.join("\n\n---\n\n");

	return `You are an autonomous agent addressing pull request review feedback.
You MUST push fixes to the existing branch — do NOT create a new branch or a new PR.
Do NOT use interactive tools, ask clarifying questions, or wait for user input. You are running unattended.

## Issue

- **ID:** ${issue.id}
- **Title:** ${issue.title}

## Review Comments

${commentSections}

## Instructions

1. Read each review comment carefully and understand what needs to be changed.
2. Address every comment — fix the code, refactor as requested, or add explanations in code where appropriate.
3. Commit all changes with the message: \`fix: address review feedback\`
4. Push the fix to the existing branch: \`git push origin ${branch}\`
   If push is rejected, pull first: \`git pull --rebase origin ${branch}\` then push again.

## Rules

- All commits and messages MUST be in English.
- Do NOT create a new branch or a new PR.
- Do NOT refactor code that is unrelated to the review comments.`;
}

function parsePrNumber(prUrl: string): string {
	const match = prUrl.match(/\/pull\/(\d+)/);
	return match?.[1] ?? "";
}

function parseOwnerRepo(prUrl: string): { owner: string; repo: string } | null {
	// Matches both https://github.com/owner/repo/pull/123 and similar patterns
	const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\//);
	if (!match) return null;
	return { owner: match[1]!, repo: match[2]! };
}

async function fetchReviewDecision(prUrl: string, cwd: string): Promise<string | undefined> {
	try {
		const prNumber = parsePrNumber(prUrl);
		if (!prNumber) return undefined;

		const { stdout } = await execa("gh", ["pr", "view", prNumber, "--json", "reviewDecision"], {
			cwd,
			timeout: 15_000,
		});
		const parsed = JSON.parse(stdout) as { reviewDecision: string | null };
		return parsed.reviewDecision ?? undefined;
	} catch (err) {
		logger.warn(`Failed to fetch review decision: ${formatError(err)}`);
		return undefined;
	}
}

async function fetchReviewComments(prUrl: string, cwd: string): Promise<ReviewComment[]> {
	try {
		const prNumber = parsePrNumber(prUrl);
		const ownerRepo = parseOwnerRepo(prUrl);
		if (!prNumber || !ownerRepo) return [];

		const endpoint = `repos/${ownerRepo.owner}/${ownerRepo.repo}/pulls/${prNumber}/comments`;
		const { stdout } = await execa(
			"gh",
			[
				"api",
				endpoint,
				"--jq",
				".[] | { id: (.id | tostring), author: .user.login, body, path: .path, line: .line, url: .html_url }",
			],
			{ cwd, timeout: 15_000 },
		);

		if (!stdout.trim()) return [];

		// Each line is a separate JSON object
		return stdout
			.trim()
			.split("\n")
			.map((line) => {
				const obj = JSON.parse(line) as {
					id: string;
					author: string;
					body: string;
					path: string | null;
					line: number | null;
					url: string;
				};
				const comment: ReviewComment = {
					id: obj.id,
					author: obj.author,
					body: obj.body,
					url: obj.url,
				};
				if (obj.path) comment.path = obj.path;
				if (obj.line != null) comment.line = obj.line;
				return comment;
			});
	} catch (err) {
		logger.warn(`Failed to fetch review comments: ${formatError(err)}`);
		return [];
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function monitorReview(
	prUrl: string,
	branch: string,
	config: LisaConfig,
	issue: Issue,
	models: ModelSpec[],
	cwd: string,
	logFile: string,
	workspace: string,
	lifecycleEnv: Record<string, string>,
	buildRunOpts: (extra?: Partial<RunOptions>) => RunOptions,
): Promise<ReviewMonitorResult> {
	const reviewConfig = config.review_monitor;
	if (!isReviewMonitorEnabled(reviewConfig)) {
		return { finalState: "review_pending", attempts: 0 };
	}

	// Only GitHub platforms are supported
	const platform = config.platform;
	if (platform !== "cli" && platform !== "token") {
		logger.log("Review monitoring is only supported for GitHub platforms. Skipping.");
		return { finalState: "review_pending", attempts: 0 };
	}

	const pollInterval = (reviewConfig?.poll_interval ?? 60) * 1000;
	const pollTimeout = (reviewConfig?.poll_timeout ?? 3600) * 1000;

	let attempts = 0;
	let lastFingerprint: string | null = null;
	let firstTriggeredAt: number | null = null;

	const deadline = Date.now() + pollTimeout;

	updateSessionState(workspace, issue.id, "review_pending");

	while (Date.now() < deadline) {
		startSpinner(`${issue.id} — waiting for review...`);
		await sleep(pollInterval);
		stopSpinner();

		const rawDecision = await fetchReviewDecision(prUrl, cwd);
		const decision = parseReviewDecision(rawDecision);

		if (decision === "approved") {
			logger.ok(`PR approved for ${issue.id}.`);
			updateSessionState(workspace, issue.id, "approved");
			return { finalState: "approved", attempts };
		}

		if (decision === "changes_requested") {
			if (firstTriggeredAt === null) {
				firstTriggeredAt = Date.now();
			}

			const reaction = resolveReaction("changes_requested", config.reactions);

			if (shouldEscalate(reaction, attempts, firstTriggeredAt)) {
				executeNotify("changes_requested", issue.id, "Escalating: max retries or time exceeded.");
				updateSessionState(workspace, issue.id, "changes_requested");
				return { finalState: "changes_requested", attempts };
			}

			const comments = await fetchReviewComments(prUrl, cwd);
			const fingerprint = buildReviewFingerprint(comments);

			// Skip if same feedback as last time
			if (fingerprint && fingerprint === lastFingerprint) {
				logger.log(`Review fingerprint unchanged for ${issue.id}. Skipping re-invocation.`);
				continue;
			}

			lastFingerprint = fingerprint;

			// Also check session record fingerprint
			const record = loadSessionRecord(workspace, issue.id);
			if (record?.reviewFingerprint && record.reviewFingerprint === fingerprint) {
				logger.log(`Review fingerprint matches persisted record for ${issue.id}. Skipping.`);
				continue;
			}

			const action = reaction.action;

			if (action === "skip") {
				logger.log(`Reaction action is 'skip' for changes_requested on ${issue.id}.`);
				updateSessionState(workspace, issue.id, "changes_requested");
				return { finalState: "changes_requested", attempts };
			}

			if (action === "notify") {
				executeNotify("changes_requested", issue.id, "Review requested changes.");
				updateSessionState(workspace, issue.id, "changes_requested");
				return { finalState: "changes_requested", attempts };
			}

			// action === "reinvoke"
			attempts++;

			updateSessionState(workspace, issue.id, "changes_requested", {
				reviewFingerprint: fingerprint,
			});

			const recoveryPrompt = buildReviewRecoveryPrompt(issue, comments, branch);
			startSpinner(`${issue.id} — addressing review feedback (attempt ${attempts})...`);
			const result = await runWithFallback(models, recoveryPrompt, buildRunOpts());
			stopSpinner();

			if (!result.success) {
				logger.error(`Review fix attempt ${attempts} failed for ${issue.id}.`);
			} else {
				logger.ok(`Review fix pushed for ${issue.id}. Re-polling for new review...`);
			}

			// Reset state to review_pending and continue polling
			updateSessionState(workspace, issue.id, "review_pending");
		}
	}

	logger.warn(
		`Review monitor timed out for ${issue.id} after ${reviewConfig?.poll_timeout ?? 3600}s.`,
	);
	return { finalState: "review_pending", attempts };
}
