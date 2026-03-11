import { execa } from "execa";

export interface PrReview {
	author: string;
	state: string;
	body: string;
	submittedAt: string;
}

export interface PrComment {
	author: string;
	body: string;
	path?: string;
	line?: number;
	createdAt: string;
}

export interface PrFeedback {
	prUrl: string;
	title: string;
	state: "closed" | "merged" | "open";
	reviews: PrReview[];
	comments: PrComment[];
}

/**
 * Parses owner, repo, and PR number from a GitHub PR URL.
 */
export function parsePrUrl(
	prUrl: string,
): { owner: string; repo: string; prNumber: string } | null {
	const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
	if (!match) return null;
	return { owner: match[1] ?? "", repo: match[2] ?? "", prNumber: match[3] ?? "" };
}

/**
 * Fetches PR state, reviews, and inline comments from GitHub.
 * Requires the `gh` CLI to be authenticated.
 */
export async function fetchPrFeedback(prUrl: string): Promise<PrFeedback> {
	const parsed = parsePrUrl(prUrl);
	if (!parsed) {
		throw new Error(`Invalid GitHub PR URL: ${prUrl}`);
	}
	const { owner, repo, prNumber } = parsed;

	const { stdout: prJson } = await execa("gh", [
		"pr",
		"view",
		prUrl,
		"--json",
		"title,state,mergedAt",
	]);
	const { title, state, mergedAt } = JSON.parse(prJson) as {
		title: string;
		state: string;
		mergedAt: string | null;
	};

	let prState: "closed" | "merged" | "open";
	if (mergedAt) {
		prState = "merged";
	} else if (state === "CLOSED") {
		prState = "closed";
	} else {
		prState = "open";
	}

	const { stdout: reviewsJson } = await execa("gh", [
		"api",
		`/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
	]);
	const rawReviews = JSON.parse(reviewsJson) as Array<{
		user: { login: string };
		state: string;
		body: string;
		submitted_at: string;
	}>;
	const reviews: PrReview[] = rawReviews
		.filter((r) => r.body.trim())
		.map((r) => ({
			author: r.user.login,
			state: r.state,
			body: r.body,
			submittedAt: r.submitted_at,
		}));

	const { stdout: commentsJson } = await execa("gh", [
		"api",
		`/repos/${owner}/${repo}/pulls/${prNumber}/comments`,
	]);
	const rawComments = JSON.parse(commentsJson) as Array<{
		user: { login: string };
		body: string;
		path: string;
		line?: number;
		created_at: string;
	}>;
	const comments: PrComment[] = rawComments.map((c) => ({
		author: c.user.login,
		body: c.body,
		path: c.path,
		line: c.line,
		createdAt: c.created_at,
	}));

	return { prUrl, title, state: prState, reviews, comments };
}

/**
 * Formats a PR feedback object as a guardrails markdown entry.
 */
export function formatPrFeedbackEntry(feedback: PrFeedback, issueId: string, date: string): string {
	const lines: string[] = [
		`## PR Feedback for Issue ${issueId} (${date})`,
		`- PR: ${feedback.prUrl}`,
		`- Title: ${feedback.title}`,
		`- Status: Closed without merge`,
	];

	if (feedback.reviews.length > 0) {
		lines.push("- Reviews:");
		lines.push("```");
		for (const review of feedback.reviews) {
			lines.push(`[${review.author}] ${review.state}: ${review.body}`);
		}
		lines.push("```");
	}

	if (feedback.comments.length > 0) {
		lines.push("- Inline comments:");
		lines.push("```");
		for (const comment of feedback.comments) {
			const location = comment.path
				? ` (${comment.path}${comment.line ? `:${comment.line}` : ""})`
				: "";
			lines.push(`[${comment.author}]${location}: ${comment.body}`);
		}
		lines.push("```");
	}

	return lines.join("\n");
}
