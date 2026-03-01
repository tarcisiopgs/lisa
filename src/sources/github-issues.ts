import * as logger from "../output/logger.js";
import type { Issue, Source, SourceConfig } from "../types/index.js";

const API_URL = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 30_000;

const PRIORITY_LABELS = ["p1", "p2", "p3"];

// Matches "depends on #N", "blocked by #N", case-insensitive, supports multiple formats
const DEPENDENCY_PATTERN = /(?:depends\s+on|blocked\s+by)\s+#(\d+)/gi;

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
	state?: string;
}

interface GitHubPr {
	merged: boolean;
	state: string;
}

export function parseGitHubPrUrl(
	url: string,
): { owner: string; repo: string; number: string } | null {
	const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
	if (match?.[1] && match?.[2] && match?.[3]) {
		return { owner: match[1], repo: match[2], number: match[3] };
	}
	return null;
}

export async function checkPrMerged(prUrl: string): Promise<boolean> {
	const parsed = parseGitHubPrUrl(prUrl);
	if (!parsed) return false;
	try {
		const pr = await githubGet<GitHubPr>(
			`/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}`,
		);
		return pr.merged === true;
	} catch {
		return false;
	}
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

export function parseDependencies(body: string | null): number[] {
	if (!body) return [];
	const deps: number[] = [];
	const matches = body.matchAll(DEPENDENCY_PATTERN);
	for (const match of matches) {
		const num = Number.parseInt(match[1] ?? "", 10);
		if (!Number.isNaN(num)) deps.push(num);
	}
	return [...new Set(deps)];
}

function makeIssueId(owner: string, repo: string, number: number): string {
	return `${owner}/${repo}#${number}`;
}

export class GitHubIssuesSource implements Source {
	name = "github-issues" as const;

	async fetchNextIssue(config: SourceConfig): Promise<Issue | null> {
		const { owner, repo } = parseOwnerRepo(config.team);
		// GitHub valid states: open, closed, all. If pick_from is not a valid state
		// (e.g. "in-progress" used as orphan detection label), filter by that label instead.
		const validStates = ["open", "closed", "all"];
		const isValidState = validStates.includes(config.pick_from);
		const filterLabels = isValidState
			? Array.isArray(config.label)
				? config.label
				: [config.label]
			: [config.pick_from];
		const label = filterLabels.map((l) => encodeURIComponent(l)).join(",");
		const path = `/repos/${owner}/${repo}/issues?labels=${label}&state=open&sort=created&direction=asc&per_page=100`;

		const issues = await githubGet<GitHubIssue[]>(path);
		if (issues.length === 0) return null;

		// Check blocking relations parsed from issue body
		const unblocked: GitHubIssue[] = [];
		const blocked: { number: number; blockers: number[] }[] = [];
		// Track closed (resolved) blocker IDs per issue for dependency resolution
		const closedBlockerMap = new Map<number, string[]>();

		for (const issue of issues) {
			const depNumbers = parseDependencies(issue.body);
			if (depNumbers.length === 0) {
				unblocked.push(issue);
				continue;
			}

			// Check if any referenced issues are still open
			const activeBlockers: number[] = [];
			const closedBlockers: string[] = [];
			for (const depNum of depNumbers) {
				try {
					const dep = await githubGet<GitHubIssue>(`/repos/${owner}/${repo}/issues/${depNum}`);
					if (!dep.state || dep.state === "open") {
						activeBlockers.push(depNum);
					} else {
						closedBlockers.push(makeIssueId(owner, repo, depNum));
					}
				} catch {
					// If we can't fetch, assume still open
					activeBlockers.push(depNum);
				}
			}

			if (closedBlockers.length > 0) {
				closedBlockerMap.set(issue.number, closedBlockers);
			}

			if (activeBlockers.length === 0) {
				unblocked.push(issue);
			} else {
				blocked.push({ number: issue.number, blockers: activeBlockers });
			}
		}

		if (unblocked.length === 0) {
			if (blocked.length > 0) {
				logger.warn("No unblocked issues found. Blocked issues:");
				for (const entry of blocked) {
					logger.warn(
						`  #${entry.number} — blocked by: ${entry.blockers.map((b) => `#${b}`).join(", ")}`,
					);
				}
			}
			return null;
		}

		// Sort by priority labels (p1/p2/p3) first, then by created_at ascending
		const sorted = [...unblocked].sort((a, b) => {
			const pa = priorityRank(a.labels);
			const pb = priorityRank(b.labels);
			if (pa !== pb) return pa - pb;
			return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
		});

		const issue = sorted[0];
		if (!issue) return null;

		const completedBlockerIds = closedBlockerMap.get(issue.number);
		return {
			id: makeIssueId(owner, repo, issue.number),
			title: issue.title,
			description: issue.body ?? "",
			url: issue.html_url,
			...(completedBlockerIds && { completedBlockerIds }),
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

	async updateStatus(issueId: string, labelToAdd: string, config?: SourceConfig): Promise<void> {
		const ref = parseGitHubIssueNumber(issueId);

		if (config && config.in_progress !== config.pick_from) {
			const filterLabels = Array.isArray(config.label) ? config.label : [config.label];
			const isMovingToInProgress = labelToAdd === config.in_progress;

			if (isMovingToInProgress) {
				// Add in_progress label and remove filter labels (prevent re-picking)
				await githubPost(`/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/labels`, {
					labels: [labelToAdd],
				});
				for (const label of filterLabels) {
					try {
						await githubDelete(
							`/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/labels/${encodeURIComponent(label)}`,
						);
					} catch {
						// Label may not exist; ignore
					}
				}
				return;
			}

			// Reverting to pick_from: add back filter labels and remove in_progress label
			await githubPost(`/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/labels`, {
				labels: filterLabels,
			});
			try {
				await githubDelete(
					`/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/labels/${encodeURIComponent(config.in_progress)}`,
				);
			} catch {
				// Label may not exist; ignore
			}
			return;
		}

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

	async completeIssue(
		issueId: string,
		_status: string,
		labelToRemove?: string,
		config?: SourceConfig,
	): Promise<void> {
		const ref = parseGitHubIssueNumber(issueId);
		await githubPatch(`/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`, {
			state: "closed",
		});
		if (labelToRemove) {
			await this.removeLabel(issueId, labelToRemove);
		}
		// Also remove in_progress label if config-aware and in_progress differs from pick_from
		if (config && config.in_progress !== config.pick_from) {
			try {
				await githubDelete(
					`/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/labels/${encodeURIComponent(config.in_progress)}`,
				);
			} catch {
				// Label may not exist; ignore
			}
		}
	}

	async listIssues(config: SourceConfig): Promise<Issue[]> {
		const { owner, repo } = parseOwnerRepo(config.team);
		const labels = Array.isArray(config.label) ? config.label : [config.label];
		const label = labels.map((l) => encodeURIComponent(l)).join(",");
		const path = `/repos/${owner}/${repo}/issues?labels=${label}&state=open&sort=created&direction=asc&per_page=100`;

		const issues = await githubGet<GitHubIssue[]>(path);
		return issues.map((issue) => ({
			id: makeIssueId(owner, repo, issue.number),
			title: issue.title,
			description: issue.body ?? "",
			url: issue.html_url,
		}));
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
