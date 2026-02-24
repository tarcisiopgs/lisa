import type { Issue, Source, SourceConfig } from "../types/index.js";

const DEFAULT_BASE_URL = "https://gitlab.com";
const REQUEST_TIMEOUT_MS = 30_000;

const PRIORITY_LABELS = ["p1", "p2", "p3"];

function getBaseUrl(): string {
	return (process.env.GITLAB_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
}

function getAuthHeaders(): Record<string, string> {
	const token = process.env.GITLAB_TOKEN;
	if (!token) throw new Error("GITLAB_TOKEN must be set");
	return { "PRIVATE-TOKEN": token };
}

async function gitlabFetch<T>(method: string, path: string, body?: unknown): Promise<T> {
	const url = `${getBaseUrl()}/api/v4${path}`;
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
		throw new Error(`GitLab API error (${res.status}): ${text}`);
	}

	if (method === "DELETE" || res.status === 204) return undefined as T;
	return (await res.json()) as T;
}

async function gitlabGet<T>(path: string): Promise<T> {
	return gitlabFetch<T>("GET", path);
}

async function gitlabPost<T>(path: string, body: unknown): Promise<T> {
	return gitlabFetch<T>("POST", path, body);
}

async function gitlabPut<T>(path: string, body: unknown): Promise<T> {
	return gitlabFetch<T>("PUT", path, body);
}

interface GitLabIssue {
	id: number;
	iid: number;
	title: string;
	description: string | null;
	web_url: string;
	labels: string[];
	created_at: string;
}

function priorityRank(labels: string[]): number {
	for (let i = 0; i < PRIORITY_LABELS.length; i++) {
		const p = PRIORITY_LABELS[i];
		if (p && labels.some((l) => l.toLowerCase() === p)) return i;
	}
	return PRIORITY_LABELS.length;
}

// Composite issue ID format: "{project}#{iid}" e.g. "namespace/project#123" or "42#123"
function makeIssueId(project: string, iid: number): string {
	return `${project}#${iid}`;
}

function splitIssueId(id: string): { project: string; iid: string } {
	const hashIdx = id.lastIndexOf("#");
	if (hashIdx === -1) {
		// Plain IID — no project context; caller must handle
		return { project: "", iid: id };
	}
	return { project: id.slice(0, hashIdx), iid: id.slice(hashIdx + 1) };
}

export class GitLabIssuesSource implements Source {
	name = "gitlab-issues" as const;

	async fetchNextIssue(config: SourceConfig): Promise<Issue | null> {
		const project = parseGitLabProject(config.team);
		const label = encodeURIComponent(config.label);
		const path = `/projects/${project}/issues?labels=${label}&state=opened&per_page=100`;

		const issues = await gitlabGet<GitLabIssue[]>(path);
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
			id: makeIssueId(config.team, issue.iid),
			title: issue.title,
			description: issue.description ?? "",
			url: issue.web_url,
		};
	}

	async fetchIssueById(id: string): Promise<Issue | null> {
		const ref = parseGitLabIssueRef(id);

		try {
			const project = parseGitLabProject(ref.project);
			const issue = await gitlabGet<GitLabIssue>(`/projects/${project}/issues/${ref.iid}`);
			return {
				id: makeIssueId(ref.project, issue.iid),
				title: issue.title,
				description: issue.description ?? "",
				url: issue.web_url,
			};
		} catch {
			return null;
		}
	}

	async updateStatus(issueId: string, labelToAdd: string): Promise<void> {
		const { project, iid } = splitIssueId(issueId);
		const encodedProject = parseGitLabProject(project);

		const issue = await gitlabGet<GitLabIssue>(`/projects/${encodedProject}/issues/${iid}`);
		const labels = [...new Set([...issue.labels, labelToAdd])];

		await gitlabPut(`/projects/${encodedProject}/issues/${iid}`, { labels: labels.join(",") });
	}

	async attachPullRequest(issueId: string, prUrl: string): Promise<void> {
		const { project, iid } = splitIssueId(issueId);
		const encodedProject = parseGitLabProject(project);

		await gitlabPost(`/projects/${encodedProject}/issues/${iid}/notes`, {
			body: `Pull request: ${prUrl}`,
		});
	}

	async completeIssue(issueId: string, _status: string, labelToRemove?: string): Promise<void> {
		const { project, iid } = splitIssueId(issueId);
		const encodedProject = parseGitLabProject(project);

		const issue = await gitlabGet<GitLabIssue>(`/projects/${encodedProject}/issues/${iid}`);
		const labels = labelToRemove
			? issue.labels.filter((l) => l.toLowerCase() !== labelToRemove.toLowerCase())
			: issue.labels;

		await gitlabPut(`/projects/${encodedProject}/issues/${iid}`, {
			state_event: "close",
			labels: labels.join(","),
		});
	}

	async removeLabel(issueId: string, labelToRemove: string): Promise<void> {
		const { project, iid } = splitIssueId(issueId);
		const encodedProject = parseGitLabProject(project);

		const issue = await gitlabGet<GitLabIssue>(`/projects/${encodedProject}/issues/${iid}`);
		const filtered = issue.labels.filter((l) => l.toLowerCase() !== labelToRemove.toLowerCase());

		if (filtered.length === issue.labels.length) return;

		await gitlabPut(`/projects/${encodedProject}/issues/${iid}`, {
			labels: filtered.join(","),
		});
	}
}

// parseGitLabProject converts a project input (namespace/name or numeric ID) to an
// API-safe project identifier (URL-encoded path or plain numeric ID).
export function parseGitLabProject(input: string): string {
	// Numeric ID — use as-is
	if (/^\d+$/.test(input)) return input;

	// namespace/project path — URL-encode so it works as a path segment
	return encodeURIComponent(input);
}

interface GitLabIssueRef {
	project: string;
	iid: string;
}

// parseGitLabIssueRef extracts project and IID from a GitLab issue URL,
// composite key "namespace/project#iid", or plain IID.
export function parseGitLabIssueRef(input: string): GitLabIssueRef {
	// Full GitLab URL: https://gitlab.com/namespace/project/-/issues/123
	const urlMatch = input.match(/gitlab(?:\.com|[^/]*)\/(.+?)\/-\/issues\/(\d+)/);
	if (urlMatch?.[1] && urlMatch?.[2]) {
		return { project: urlMatch[1], iid: urlMatch[2] };
	}

	// Composite format "namespace/project#123" or "42#123"
	const hashIdx = input.lastIndexOf("#");
	if (hashIdx !== -1) {
		return { project: input.slice(0, hashIdx), iid: input.slice(hashIdx + 1) };
	}

	// Plain IID — no project context
	return { project: "", iid: input };
}
