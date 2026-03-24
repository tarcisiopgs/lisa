import { execa } from "execa";
import { formatError } from "../errors.js";

export type CiCheckStatus = "passing" | "failing" | "pending" | "unknown";

export interface MergeResult {
	success: boolean;
	error?: string;
}

/**
 * Check CI/checks status for a PR before merging.
 */
export async function checkPrCiStatus(prUrl: string): Promise<CiCheckStatus> {
	if (prUrl.includes("github.com")) {
		return checkGitHubPrCi(prUrl);
	}
	if (prUrl.includes("gitlab")) {
		return checkGitLabPrCi(prUrl);
	}
	// Bitbucket: no easy CI check from URL, return unknown
	return "unknown";
}

async function checkGitHubPrCi(prUrl: string): Promise<CiCheckStatus> {
	try {
		const { stdout } = await execa("gh", ["pr", "checks", prUrl, "--json", "bucket"], {
			timeout: 15_000,
		});
		const checks = JSON.parse(stdout) as { bucket: string }[];
		if (checks.length === 0) return "unknown";
		const hasFailing = checks.some((c) => c.bucket === "fail");
		const hasPending = checks.some((c) => c.bucket === "pending");
		if (hasFailing) return "failing";
		if (hasPending) return "pending";
		return "passing";
	} catch {
		return "unknown";
	}
}

async function checkGitLabPrCi(prUrl: string): Promise<CiCheckStatus> {
	try {
		// Parse GitLab MR URL: https://gitlab.com/namespace/project/-/merge_requests/123
		const match = prUrl.match(/gitlab[^/]*\/(.+)\/-\/merge_requests\/(\d+)/);
		if (!match) return "unknown";
		const projectPath = match[1];
		const mrIid = match[2];
		const token = process.env.GITLAB_TOKEN;
		if (!token) return "unknown";
		// Extract host from URL
		const hostMatch = prUrl.match(/https?:\/\/([^/]+)/);
		const host = hostMatch ? hostMatch[1] : "gitlab.com";
		const res = await fetch(
			`https://${host}/api/v4/projects/${encodeURIComponent(projectPath!)}/merge_requests/${mrIid}`,
			{
				headers: { "PRIVATE-TOKEN": token },
				signal: AbortSignal.timeout(15_000),
			},
		);
		if (!res.ok) return "unknown";
		const data = (await res.json()) as { pipeline?: { status: string } };
		if (!data.pipeline) return "unknown";
		if (data.pipeline.status === "success") return "passing";
		if (data.pipeline.status === "failed") return "failing";
		return "pending";
	} catch {
		return "unknown";
	}
}

/**
 * Merge a PR and delete the source branch.
 */
export async function mergePr(prUrl: string): Promise<MergeResult> {
	if (prUrl.includes("github.com")) {
		return mergeGitHubPr(prUrl);
	}
	if (prUrl.includes("gitlab")) {
		return mergeGitLabPr(prUrl);
	}
	if (prUrl.includes("bitbucket")) {
		return mergeBitbucketPr(prUrl);
	}
	return { success: false, error: "Unsupported platform" };
}

async function mergeGitHubPr(prUrl: string): Promise<MergeResult> {
	try {
		await execa("gh", ["pr", "merge", prUrl, "--delete-branch"], { timeout: 30_000 });
		return { success: true };
	} catch (err) {
		return { success: false, error: formatError(err) };
	}
}

async function mergeGitLabPr(prUrl: string): Promise<MergeResult> {
	try {
		const match = prUrl.match(/gitlab[^/]*\/(.+)\/-\/merge_requests\/(\d+)/);
		if (!match) return { success: false, error: "Cannot parse GitLab MR URL" };
		const projectPath = match[1];
		const mrIid = match[2];
		const token = process.env.GITLAB_TOKEN;
		if (!token) return { success: false, error: "GITLAB_TOKEN is not set" };
		const hostMatch = prUrl.match(/https?:\/\/([^/]+)/);
		const host = hostMatch ? hostMatch[1] : "gitlab.com";
		const res = await fetch(
			`https://${host}/api/v4/projects/${encodeURIComponent(projectPath!)}/merge_requests/${mrIid}/merge`,
			{
				method: "PUT",
				headers: {
					"PRIVATE-TOKEN": token,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ should_remove_source_branch: true }),
				signal: AbortSignal.timeout(30_000),
			},
		);
		if (!res.ok) {
			const text = await res.text();
			return { success: false, error: `GitLab merge failed (${res.status}): ${text}` };
		}
		return { success: true };
	} catch (err) {
		return { success: false, error: formatError(err) };
	}
}

async function mergeBitbucketPr(prUrl: string): Promise<MergeResult> {
	try {
		// Parse: https://bitbucket.org/workspace/repo/pull-requests/123
		const match = prUrl.match(/bitbucket\.org\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)/);
		if (!match) return { success: false, error: "Cannot parse Bitbucket PR URL" };
		const workspace = match[1];
		const repoSlug = match[2];
		const prId = match[3];
		const token = process.env.BITBUCKET_TOKEN;
		if (!token) return { success: false, error: "BITBUCKET_TOKEN is not set" };
		// Merge the PR
		const mergeRes = await fetch(
			`https://api.bitbucket.org/2.0/repositories/${workspace}/${repoSlug}/pullrequests/${prId}/merge`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ close_source_branch: true }),
				signal: AbortSignal.timeout(30_000),
			},
		);
		if (!mergeRes.ok) {
			const text = await mergeRes.text();
			return {
				success: false,
				error: `Bitbucket merge failed (${mergeRes.status}): ${text}`,
			};
		}
		return { success: true };
	} catch (err) {
		return { success: false, error: formatError(err) };
	}
}
