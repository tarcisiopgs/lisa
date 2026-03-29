import { SourceError } from "../errors.js";
import * as logger from "../output/logger.js";
import type { CreateIssueOpts, Issue, Source, SourceConfig } from "../types/index.js";
import { type ApiClient, createApiClient, normalizeLabels } from "./base.js";

const DEFAULT_BASE_URL = "https://gitlab.com";

const PRIORITY_LABELS = ["p1", "p2", "p3"];

function getBaseUrl(): string {
	return (process.env.GITLAB_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
}

function getAuthHeaders(): Record<string, string> {
	const token = process.env.GITLAB_TOKEN;
	if (!token) throw new SourceError("GITLAB_TOKEN must be set", "gitlab-issues");
	return { "PRIVATE-TOKEN": token };
}

let _api: ApiClient | undefined;
function api(): ApiClient {
	if (!_api) {
		_api = createApiClient(`${getBaseUrl()}/api/v4`, getAuthHeaders, "GitLab");
	}
	return _api;
}

interface GitLabIssue {
	id: number;
	iid: number;
	title: string;
	description: string | null;
	web_url: string;
	labels: string[];
	created_at: string;
	state: string;
}

interface GitLabMr {
	state: string;
}

export function parseGitLabMrUrl(url: string): { project: string; iid: string } | null {
	const match = url.match(/gitlab(?:\.com|[^/]*)\/(.+?)\/-\/merge_requests\/(\d+)/);
	if (match?.[1] && match?.[2]) {
		return { project: match[1], iid: match[2] };
	}
	return null;
}

export async function checkPrMerged(prUrl: string): Promise<boolean> {
	const parsed = parseGitLabMrUrl(prUrl);
	if (!parsed) return false;
	try {
		const encodedProject = parseGitLabProject(parsed.project);
		const mr = await api().get<GitLabMr>(
			`/projects/${encodedProject}/merge_requests/${parsed.iid}`,
		);
		return mr.state === "merged";
	} catch {
		return false;
	}
}

// GitLab Issue Links API returns the linked issue's fields directly,
// with link_type appended. There are no nested source/target objects.
interface GitLabIssueLink {
	iid: number;
	state: string;
	link_type: string;
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
		const project = parseGitLabProject(config.scope);
		// GitLab valid states: opened, closed, all. If pick_from is a non-empty, non-standard-state
		// value (e.g. "in-progress" used as orphan detection label), filter by that label instead.
		const validStates = ["opened", "closed", "all"];
		const isOrphanDetection = !!config.pick_from && !validStates.includes(config.pick_from);
		const filterLabels = isOrphanDetection ? [config.pick_from] : normalizeLabels(config);
		const label = filterLabels.map((l) => encodeURIComponent(l)).join(",");
		const issues: GitLabIssue[] = [];
		let page = 1;

		while (true) {
			const path = `/projects/${project}/issues?labels=${label}&state=opened&per_page=100&page=${page}`;
			const batch = await api().get<GitLabIssue[]>(path);
			issues.push(...batch);
			if (batch.length < 100) break;
			page++;
		}

		if (issues.length === 0) return null;

		// Check blocking relations for each issue
		const unblocked: GitLabIssue[] = [];
		const blocked: { iid: number; blockers: number[] }[] = [];

		for (const issue of issues) {
			const links = await api().get<GitLabIssueLink[]>(
				`/projects/${project}/issues/${issue.iid}/links`,
			);

			const activeBlockers = links
				.filter((link) => {
					// "is_blocked_by": the linked issue blocks this issue
					if (link.link_type === "is_blocked_by") {
						return link.state !== "closed";
					}
					return false;
				})
				.map((link) => link.iid);

			if (activeBlockers.length === 0) {
				unblocked.push(issue);
			} else {
				blocked.push({ iid: issue.iid, blockers: activeBlockers });
			}
		}

		if (unblocked.length === 0) {
			if (blocked.length > 0) {
				logger.warn("No unblocked issues found. Blocked issues:");
				for (const entry of blocked) {
					logger.warn(
						`  #${entry.iid} — blocked by: ${entry.blockers.map((b) => `#${b}`).join(", ")}`,
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

		return {
			id: makeIssueId(config.scope, issue.iid),
			title: issue.title,
			description: issue.description ?? "",
			url: issue.web_url,
		};
	}

	async fetchIssueById(id: string): Promise<Issue | null> {
		const ref = parseGitLabIssueRef(id);

		try {
			const project = parseGitLabProject(ref.project);
			const issue = await api().get<GitLabIssue>(`/projects/${project}/issues/${ref.iid}`);
			return {
				id: makeIssueId(ref.project, issue.iid),
				title: issue.title,
				description: issue.description ?? "",
				url: issue.web_url,
				status: issue.state,
			};
		} catch {
			return null;
		}
	}

	async updateStatus(issueId: string, labelToAdd: string, config?: SourceConfig): Promise<void> {
		const { project, iid } = splitIssueId(issueId);
		const encodedProject = parseGitLabProject(project);

		const issue = await api().get<GitLabIssue>(`/projects/${encodedProject}/issues/${iid}`);

		if (config && config.in_progress !== config.pick_from) {
			const filterLabels = normalizeLabels(config);
			const isMovingToInProgress = labelToAdd === config.in_progress;

			if (isMovingToInProgress) {
				// Add in_progress label and remove filter labels (prevent re-picking)
				const updated = [...new Set([...issue.labels, labelToAdd])].filter(
					(l) => !filterLabels.includes(l),
				);
				await api().put(`/projects/${encodedProject}/issues/${iid}`, {
					labels: updated.join(","),
				});
				return;
			}

			// Reverting to pick_from: add back filter labels and remove in_progress label
			const updated = [...new Set([...issue.labels, ...filterLabels])].filter(
				(l) => l !== config.in_progress,
			);
			await api().put(`/projects/${encodedProject}/issues/${iid}`, {
				labels: updated.join(","),
			});
			return;
		}

		const labels = [...new Set([...issue.labels, labelToAdd])];
		await api().put(`/projects/${encodedProject}/issues/${iid}`, { labels: labels.join(",") });
	}

	async attachPullRequest(issueId: string, prUrl: string): Promise<void> {
		const { project, iid } = splitIssueId(issueId);
		const encodedProject = parseGitLabProject(project);

		await api().post(`/projects/${encodedProject}/issues/${iid}/notes`, {
			body: `Pull request: ${prUrl}`,
		});
	}

	async completeIssue(
		issueId: string,
		_status: string,
		labelToRemove?: string,
		config?: SourceConfig,
	): Promise<void> {
		const { project, iid } = splitIssueId(issueId);
		const encodedProject = parseGitLabProject(project);

		const issue = await api().get<GitLabIssue>(`/projects/${encodedProject}/issues/${iid}`);
		let labels = labelToRemove
			? issue.labels.filter((l) => l.toLowerCase() !== labelToRemove.toLowerCase())
			: issue.labels;

		// Also remove in_progress label if config-aware and in_progress differs from pick_from
		if (config && config.in_progress !== config.pick_from) {
			labels = labels.filter((l) => l !== config.in_progress);
		}

		await api().put(`/projects/${encodedProject}/issues/${iid}`, {
			state_event: "close",
			labels: labels.join(","),
		});
	}

	async listIssues(config: SourceConfig): Promise<Issue[]> {
		const project = parseGitLabProject(config.scope);
		const labelsArr = normalizeLabels(config);
		const label = labelsArr.map((l) => encodeURIComponent(l)).join(",");

		const allIssues: GitLabIssue[] = [];
		let page = 1;

		while (true) {
			const path = `/projects/${project}/issues?labels=${label}&state=opened&per_page=100&page=${page}`;
			const batch = await api().get<GitLabIssue[]>(path);
			allIssues.push(...batch);
			if (batch.length < 100) break;
			page++;
		}

		return allIssues.map((issue) => ({
			id: makeIssueId(config.scope, issue.iid),
			title: issue.title,
			description: issue.description ?? "",
			url: issue.web_url,
		}));
	}

	async listLabels(scope: string): Promise<{ value: string; label: string }[]> {
		const project = parseGitLabProject(scope);
		const results: { value: string; label: string }[] = [];
		let page = 1;

		while (true) {
			const labels = await api().get<{ name: string; description: string | null }[]>(
				`/projects/${project}/labels?per_page=100&page=${page}`,
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
		const { project, iid } = splitIssueId(issueId);
		const encodedProject = parseGitLabProject(project);

		const issue = await api().get<GitLabIssue>(`/projects/${encodedProject}/issues/${iid}`);
		const filtered = issue.labels.filter((l) => l.toLowerCase() !== labelToRemove.toLowerCase());

		if (filtered.length === issue.labels.length) return;

		await api().put(`/projects/${encodedProject}/issues/${iid}`, {
			labels: filtered.join(","),
		});
	}

	async createComment(issueId: string, body: string): Promise<string> {
		const { project, iid } = splitIssueId(issueId);
		const encodedProject = parseGitLabProject(project);
		const note = await api().post<{ id: number }>(
			`/projects/${encodedProject}/issues/${iid}/notes`,
			{ body },
		);
		return String(note.id);
	}

	async updateComment(issueId: string, commentId: string, body: string): Promise<void> {
		const { project, iid } = splitIssueId(issueId);
		const encodedProject = parseGitLabProject(project);
		await api().put(`/projects/${encodedProject}/issues/${iid}/notes/${commentId}`, { body });
	}

	async createIssue(opts: CreateIssueOpts, config: SourceConfig): Promise<string> {
		const encodedProject = parseGitLabProject(config.scope);
		const labels = Array.isArray(opts.label) ? opts.label : [opts.label];

		const issue = await api().post<{ iid: number }>(`/projects/${encodedProject}/issues`, {
			title: opts.title,
			description: opts.description,
			labels: labels.join(","),
			...(opts.order !== undefined && { weight: opts.order }),
		});

		return makeIssueId(config.scope, issue.iid);
	}

	async linkDependency(issueId: string, dependsOnId: string): Promise<void> {
		const source = splitIssueId(issueId);
		const target = splitIssueId(dependsOnId);
		const encodedProject = parseGitLabProject(source.project);

		// Get the numeric project ID for target_project_id
		const projectInfo = await api().get<{ id: number }>(
			`/projects/${parseGitLabProject(target.project)}`,
		);

		await api().post(`/projects/${encodedProject}/issues/${source.iid}/links`, {
			target_project_id: projectInfo.id,
			target_issue_iid: Number(target.iid),
			link_type: "is_blocked_by",
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
