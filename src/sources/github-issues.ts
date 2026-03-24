import { execa } from "execa";
import * as logger from "../output/logger.js";
import type { CreateIssueOpts, Issue, Source, SourceConfig } from "../types/index.js";
import { type ApiClient, createApiClient, normalizeLabels } from "./base.js";

const PRIORITY_LABELS = ["p1", "p2", "p3"];

// Matches "depends on #N", "blocked by #N", case-insensitive, supports multiple formats
const DEPENDENCY_PATTERN = /(?:depends\s+on|blocked\s+by)\s+#(\d+)/gi;

async function getToken(): Promise<string> {
	if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
	try {
		const { stdout } = await execa("gh", ["auth", "token"]);
		if (stdout.trim()) return stdout.trim();
	} catch {
		// gh CLI not available or not authenticated
	}
	throw new Error("GitHub authentication required: set GITHUB_TOKEN or run `gh auth login`");
}

async function getAuthHeaders(): Promise<Record<string, string>> {
	const token = await getToken();
	return {
		Authorization: `Bearer ${token}`,
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
	};
}

let _api: ApiClient | undefined;
function api(): ApiClient {
	if (!_api) {
		_api = createApiClient("https://api.github.com", getAuthHeaders, "GitHub");
	}
	return _api;
}

interface GitHubIssue {
	number: number;
	title: string;
	body: string | null;
	html_url: string;
	labels: { name: string }[];
	created_at: string;
	state?: string;
	// GitHub returns PRs mixed with issues; this field is present only on PRs
	pull_request?: object;
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
		const pr = await api().get<GitHubPr>(
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
		const { owner, repo } = parseOwnerRepo(config.scope);
		// GitHub valid states: open, closed, all. If pick_from is a non-empty, non-standard-state
		// value (e.g. "in-progress" used as orphan detection label), filter by that label instead.
		const validStates = ["open", "closed", "all"];
		const isOrphanDetection = !!config.pick_from && !validStates.includes(config.pick_from);
		const filterLabels = isOrphanDetection ? [config.pick_from] : normalizeLabels(config);
		const label = filterLabels.map((l) => encodeURIComponent(l)).join(",");
		const path = `/repos/${owner}/${repo}/issues?labels=${label}&state=open&sort=created&direction=asc&per_page=100`;

		const issues = (await api().get<GitHubIssue[]>(path)).filter((i) => !i.pull_request);
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
					const dep = await api().get<GitHubIssue>(`/repos/${owner}/${repo}/issues/${depNum}`);
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
			const issue = await api().get<GitHubIssue>(
				`/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`,
			);
			return {
				id: makeIssueId(ref.owner, ref.repo, issue.number),
				title: issue.title,
				description: issue.body ?? "",
				url: issue.html_url,
				status: issue.state,
			};
		} catch {
			return null;
		}
	}

	async updateStatus(issueId: string, labelToAdd: string, config?: SourceConfig): Promise<void> {
		const ref = parseGitHubIssueNumber(issueId);

		if (config && config.in_progress !== config.pick_from) {
			const filterLabels = normalizeLabels(config);
			const isMovingToInProgress = labelToAdd === config.in_progress;

			if (isMovingToInProgress) {
				// Add in_progress label and remove filter labels (prevent re-picking)
				await api().post(`/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/labels`, {
					labels: [labelToAdd],
				});
				for (const label of filterLabels) {
					try {
						await api().delete(
							`/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/labels/${encodeURIComponent(label)}`,
						);
					} catch {
						// Label may not exist; ignore
					}
				}
				return;
			}

			// Reverting to pick_from: add back filter labels and remove in_progress label
			await api().post(`/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/labels`, {
				labels: filterLabels,
			});
			try {
				await api().delete(
					`/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/labels/${encodeURIComponent(config.in_progress)}`,
				);
			} catch {
				// Label may not exist; ignore
			}
			return;
		}

		await api().post(`/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/labels`, {
			labels: [labelToAdd],
		});
	}

	async attachPullRequest(issueId: string, prUrl: string): Promise<void> {
		const ref = parseGitHubIssueNumber(issueId);
		await api().post(`/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments`, {
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
		await api().patch(`/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`, {
			state: "closed",
		});
		if (labelToRemove) {
			await this.removeLabel(issueId, labelToRemove);
		}
		// Also remove in_progress label if config-aware and in_progress differs from pick_from
		if (config && config.in_progress !== config.pick_from) {
			try {
				await api().delete(
					`/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/labels/${encodeURIComponent(config.in_progress)}`,
				);
			} catch {
				// Label may not exist; ignore
			}
		}
	}

	async listIssues(config: SourceConfig): Promise<Issue[]> {
		const { owner, repo } = parseOwnerRepo(config.scope);
		const labels = normalizeLabels(config);
		const label = labels.map((l) => encodeURIComponent(l)).join(",");
		const path = `/repos/${owner}/${repo}/issues?labels=${label}&state=open&sort=created&direction=asc&per_page=100`;

		const issues = (await api().get<GitHubIssue[]>(path)).filter((i) => !i.pull_request);
		return issues.map((issue) => ({
			id: makeIssueId(owner, repo, issue.number),
			title: issue.title,
			description: issue.body ?? "",
			url: issue.html_url,
		}));
	}

	async listLabels(scope: string): Promise<{ value: string; label: string }[]> {
		const { owner, repo } = parseOwnerRepo(scope);
		const results: { value: string; label: string }[] = [];
		let page = 1;

		while (true) {
			const labels = await api().get<{ name: string; description: string | null }[]>(
				`/repos/${owner}/${repo}/labels?per_page=100&page=${page}`,
			);
			for (const l of labels) {
				results.push({
					value: l.name,
					label: l.description ? `${l.name} — ${l.description}` : l.name,
				});
			}
			if (labels.length < 100) break;
			page++;
		}

		return results;
	}

	async removeLabel(issueId: string, labelToRemove: string): Promise<void> {
		const ref = parseGitHubIssueNumber(issueId);
		try {
			await api().delete(
				`/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/labels/${encodeURIComponent(labelToRemove)}`,
			);
		} catch {
			// Label may not exist on the issue — ignore 404s silently
		}
	}

	async createComment(issueId: string, body: string): Promise<string> {
		const ref = parseGitHubIssueNumber(issueId);
		const result = await api().post<{ id: number }>(
			`/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments`,
			{ body },
		);
		return String(result.id);
	}

	async updateComment(issueId: string, commentId: string, body: string): Promise<void> {
		const ref = parseGitHubIssueNumber(issueId);
		await api().patch(`/repos/${ref.owner}/${ref.repo}/issues/comments/${commentId}`, { body });
	}

	async createIssue(opts: CreateIssueOpts, config: SourceConfig): Promise<string> {
		const { owner, repo } = parseOwnerRepo(config.scope);
		const labels = Array.isArray(opts.label) ? opts.label : [opts.label];

		const issue = await api().post<{ number: number }>(`/repos/${owner}/${repo}/issues`, {
			title: opts.title,
			body: opts.description,
			labels,
		});

		return makeIssueId(owner, repo, issue.number);
	}
}
