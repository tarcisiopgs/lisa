import type { Issue, Source, SourceConfig } from "../types.js";

const API_URL = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 30_000;

const PRIORITY_LABELS = ["p1", "p2", "p3"];

function getAuthHeaders(): Record<string, string> {
	const token = process.env.GITHUB_TOKEN;
	if (!token) throw new Error("GITHUB_TOKEN must be set");
	return {
		Authorization: `Bearer ${token}`,
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
	};
}

async function githubFetch<T>(method: string, path: string, body?: unknown): Promise<T> {
	const url = `${API_URL}${path}`;
	const headers: Record<string, string> = {
		...getAuthHeaders(),
		"Content-Type": "application/json",
	};

	const res = await fetch(url, {
		method,
		headers,
		body: body !== undefined ? JSON.stringify(body) : undefined,
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`GitHub API error (${res.status}): ${text}`);
	}

	if (method === "DELETE" || res.status === 204) return undefined as T;
	return (await res.json()) as T;
}

async function githubGet<T>(path: string): Promise<T> {
	return githubFetch<T>("GET", path);
}

async function githubPost<T>(path: string, body: unknown): Promise<T> {
	return githubFetch<T>("POST", path, body);
}

async function githubPatch<T>(path: string, body: unknown): Promise<T> {
	return githubFetch<T>("PATCH", path, body);
}

async function githubDelete(path: string): Promise<void> {
	await githubFetch<void>("DELETE", path);
}

interface GitHubIssue {
	number: number;
	title: string;
	body: string | null;
	html_url: string;
	labels: { name: string }[];
	created_at: string;
}

function priorityRank(labels: { name: string }[]): number {
	const names = labels.map((l) => l.name.toLowerCase());
	for (let i = 0; i < PRIORITY_LABELS.length; i++) {
		const p = PRIORITY_LABELS[i];
		if (p && names.includes(p)) return i;
	}
	return PRIORITY_LABELS.length;
}

function parseOwnerRepo(team: string): { owner: string; repo: string } {
	const parts = team.split("/");
	if (parts.length !== 2 || !parts[0] || !parts[1]) {
		throw new Error(`Invalid owner/repo format: "${team}". Expected "owner/repo".`);
	}
	return { owner: parts[0], repo: parts[1] };
}

export function parseGitHubIssueNumber(id: string): {
	owner: string;
	repo: string;
	number: string;
} {
	// Full GitHub URL: https://github.com/owner/repo/issues/123
	const urlMatch = id.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
	if (urlMatch?.[1] && urlMatch?.[2] && urlMatch?.[3]) {
		return { owner: urlMatch[1], repo: urlMatch[2], number: urlMatch[3] };
	}

	// Composite format "owner/repo#123"
	const hashIdx = id.lastIndexOf("#");
	if (hashIdx !== -1) {
		const ref = id.slice(0, hashIdx);
		const num = id.slice(hashIdx + 1);
		const { owner, repo } = parseOwnerRepo(ref);
		return { owner, repo, number: num };
	}

	// Plain number — no owner/repo context
	return { owner: "", repo: "", number: id };
}

function makeIssueId(owner: string, repo: string, number: number): string {
	return `${owner}/${repo}#${number}`;
}

export class GitHubIssuesSource implements Source {
	name = "github-issues" as const;

	async fetchNextIssue(config: SourceConfig): Promise<Issue | null> {
		const { owner, repo } = parseOwnerRepo(config.team);
		const label = encodeURIComponent(config.label);
		const path = `/repos/${owner}/${repo}/issues?labels=${label}&state=open&sort=created&direction=asc&per_page=100`;

		const issues = await githubGet<GitHubIssue[]>(path);
		if (issues.length === 0) return null;

		// Sort by priority labels (p1/p2/p3) first, then by created_at ascending
		const sorted = [...issues].sort((a, b) => {
			const pa = priorityRank(a.labels);
			const pb = priorityRank(b.labels);
			if (pa !== pb) return pa - pb;
			return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
		});

		const issue = sorted[0];
		if (!issue) return null;

		return {
			id: makeIssueId(owner, repo, issue.number),
			title: issue.title,
			description: issue.body ?? "",
			url: issue.html_url,
		};
	}

	async fetchIssueById(id: string): Promise<Issue | null> {
		const ref = parseGitHubIssueNumber(id);

		try {
			const issue = await githubGet<GitHubIssue>(
				`/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`,
			);
			return {
				id: makeIssueId(ref.owner, ref.repo, issue.number),
				title: issue.title,
				description: issue.body ?? "",
				url: issue.html_url,
			};
		} catch {
			return null;
		}
	}

	async updateStatus(issueId: string, labelToAdd: string): Promise<void> {
		const ref = parseGitHubIssueNumber(issueId);
		await githubPost(`/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/labels`, {
			labels: [labelToAdd],
		});
	}

	async attachPullRequest(issueId: string, prUrl: string): Promise<void> {
		const ref = parseGitHubIssueNumber(issueId);
		await githubPost(`/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments`, {
			body: `Pull request: ${prUrl}`,
		});
	}

	async completeIssue(issueId: string, _status: string, labelToRemove?: string): Promise<void> {
		const ref = parseGitHubIssueNumber(issueId);
		await githubPatch(`/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`, {
			state: "closed",
		});
		if (labelToRemove) {
			await this.removeLabel(issueId, labelToRemove);
		}
	}

	async removeLabel(issueId: string, labelToRemove: string): Promise<void> {
		const ref = parseGitHubIssueNumber(issueId);
		try {
			await githubDelete(
				`/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/labels/${encodeURIComponent(labelToRemove)}`,
			);
		} catch {
			// Label may not exist on the issue — ignore 404s silently
		}
	}
}
