import { formatError, SourceError } from "../errors.js";
import * as logger from "../output/logger.js";
import type { CreateIssueOpts, Issue, Source, SourceConfig } from "../types/index.js";
import { createApiClient, normalizeLabels } from "./base.js";

const DEFAULT_BASE_URL = "https://api.plane.so";

function getBaseUrl(): string {
	return (process.env.PLANE_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
}

function getAppUrl(): string {
	const base = process.env.PLANE_BASE_URL ?? DEFAULT_BASE_URL;
	if (base === DEFAULT_BASE_URL || base.replace(/\/$/, "") === DEFAULT_BASE_URL) {
		return "https://app.plane.so";
	}
	return base.replace(/\/$/, "");
}

function getAuthHeaders(): Record<string, string> {
	const token = process.env.PLANE_API_TOKEN;
	if (!token) throw new SourceError("PLANE_API_TOKEN must be set", "plane");
	return { "X-Api-Key": token };
}

function escapeHtml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

let _api: ReturnType<typeof createApiClient> | null = null;

function api() {
	if (!_api) _api = createApiClient(`${getBaseUrl()}/api/v1`, getAuthHeaders, "Plane");
	return _api;
}

function planeGet<T>(path: string): Promise<T> {
	return api().get<T>(path);
}

function planePost<T>(path: string, body?: unknown): Promise<T> {
	return api().post<T>(path, body);
}

function planePatch<T>(path: string, body?: unknown): Promise<T> {
	return api().patch<T>(path, body);
}

function planeDelete(path: string): Promise<void> {
	return api().delete(path);
}

interface PlanePage<T> {
	count: number;
	next: string | null;
	previous: string | null;
	results: T[];
}

interface PlaneState {
	id: string;
	name: string;
	color: string;
	sequence: number;
	group: string;
}

interface PlaneLabel {
	id: string;
	name: string;
	color: string;
}

interface PlaneIssue {
	id: string;
	name: string;
	description_stripped: string | null;
	priority: string;
	state: string;
	labels: string[];
	sequence_id: number;
	project: string;
}

interface PlaneProject {
	id: string;
	name: string;
	identifier: string;
}

interface PlaneComment {
	id: string;
	comment_html: string;
}

interface PlaneRelation {
	id: string;
	relation_type: string;
	related_issue: string;
	issue: string;
}

// Handles both paginated ({ results: T[] }) and plain array responses, following all pages
async function fetchAll<T>(path: string): Promise<T[]> {
	const data = await planeGet<T[] | PlanePage<T>>(path);
	if (Array.isArray(data)) return data;

	const all: T[] = [...(data.results ?? [])];
	let nextUrl = data.next;

	while (nextUrl) {
		// next can be a full URL or a relative path; extract the path portion
		let nextPath: string;
		try {
			const url = new URL(nextUrl);
			nextPath = url.pathname + url.search;
			// Strip the base API prefix if present
			const basePrefix = `${getBaseUrl()}/api/v1`;
			const basePrefixPath = new URL(basePrefix).pathname;
			if (nextPath.startsWith(basePrefixPath)) {
				nextPath = nextPath.slice(basePrefixPath.length);
			}
		} catch {
			nextPath = nextUrl;
		}

		const page = await planeGet<T[] | PlanePage<T>>(nextPath);
		if (Array.isArray(page)) {
			all.push(...page);
			break;
		}
		all.push(...(page.results ?? []));
		nextUrl = page.next;
	}

	return all;
}

const PRIORITY_ORDER: Record<string, number> = {
	urgent: 1,
	high: 2,
	medium: 3,
	low: 4,
	none: 5,
};

function priorityRank(priority: string): number {
	return PRIORITY_ORDER[priority.toLowerCase()] ?? 5;
}

async function resolveProjectId(workspaceSlug: string, projectIdentifier: string): Promise<string> {
	const projects = await fetchAll<PlaneProject>(`/workspaces/${workspaceSlug}/projects/`);
	const project = projects.find(
		(p) =>
			p.identifier.toLowerCase() === projectIdentifier.toLowerCase() ||
			p.name.toLowerCase() === projectIdentifier.toLowerCase() ||
			p.id === projectIdentifier,
	);
	if (!project) {
		const available = projects.map((p) => `${p.name} (${p.identifier})`).join(", ");
		throw new Error(`Plane project "${projectIdentifier}" not found. Available: ${available}`);
	}
	return project.id;
}

async function resolveStateId(
	workspaceSlug: string,
	projectId: string,
	stateName: string,
): Promise<string> {
	const states = await fetchAll<PlaneState>(
		`/workspaces/${workspaceSlug}/projects/${projectId}/states/`,
	);
	const state = states.find((s) => s.name.toLowerCase() === stateName.toLowerCase());
	if (!state) {
		const available = states.map((s) => s.name).join(", ");
		throw new Error(`Plane state "${stateName}" not found. Available: ${available}`);
	}
	return state.id;
}

async function resolveLabelId(
	workspaceSlug: string,
	projectId: string,
	labelName: string,
): Promise<string> {
	const labels = await fetchAll<PlaneLabel>(
		`/workspaces/${workspaceSlug}/projects/${projectId}/labels/`,
	);
	const label = labels.find((l) => l.name.toLowerCase() === labelName.toLowerCase());
	if (!label) {
		const available = labels.map((l) => l.name).join(", ");
		throw new Error(`Plane label "${labelName}" not found. Available: ${available}`);
	}
	return label.id;
}

async function fetchLabels(workspaceSlug: string, projectId: string): Promise<PlaneLabel[]> {
	return fetchAll<PlaneLabel>(`/workspaces/${workspaceSlug}/projects/${projectId}/labels/`);
}

// Issue ID composite format: "{workspaceSlug}::{projectId}::{issueId}"
function makeIssueId(workspaceSlug: string, projectId: string, issueId: string): string {
	return `${workspaceSlug}::${projectId}::${issueId}`;
}

function parseIssueId(id: string): { workspaceSlug: string; projectId: string; issueId: string } {
	// Plane web URL: https://{host}/{workspace}/projects/{projectId}/issues/{issueId}
	const urlMatch = id.match(/\/([^/]+)\/projects\/([^/]+)\/issues\/([^/?#]+)/);
	if (urlMatch?.[1] && urlMatch?.[2] && urlMatch?.[3]) {
		return { workspaceSlug: urlMatch[1], projectId: urlMatch[2], issueId: urlMatch[3] };
	}

	// Composite format: "workspace::projectId::issueId"
	const parts = id.split("::");
	if (parts.length === 3 && parts[0] && parts[1] && parts[2]) {
		return { workspaceSlug: parts[0], projectId: parts[1], issueId: parts[2] };
	}

	throw new Error(
		`Cannot parse Plane issue ID: "${id}". Expected URL or "workspace::projectId::issueId" format.`,
	);
}

export function parsePlaneIssueId(
	id: string,
): { workspaceSlug: string; projectId: string; issueId: string } | null {
	try {
		return parseIssueId(id);
	} catch {
		return null;
	}
}

export class PlaneSource implements Source {
	name = "plane" as const;

	async fetchNextIssue(config: SourceConfig): Promise<Issue | null> {
		const workspaceSlug = config.scope;
		const projectId = await resolveProjectId(workspaceSlug, config.project);
		const stateId = await resolveStateId(workspaceSlug, projectId, config.pick_from);
		const labelNames = normalizeLabels(config);
		const labelResults = await Promise.allSettled(
			labelNames.map((name) => resolveLabelId(workspaceSlug, projectId, name)),
		);
		const labelIds = labelResults
			.filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled")
			.map((r) => r.value);

		const allIssues = await fetchAll<PlaneIssue>(
			`/workspaces/${workspaceSlug}/projects/${projectId}/work-items/?state=${stateId}&per_page=100`,
		);

		// Filter client-side by state because the Plane API ?state= param is not reliably applied.
		const matching = allIssues
			.filter((i) => i.state === stateId)
			.filter((i) => labelIds.every((lid) => i.labels.includes(lid)));
		if (matching.length === 0) return null;

		// Fetch all states to check if blocking issues are completed
		const allStates = await fetchAll<PlaneState>(
			`/workspaces/${workspaceSlug}/projects/${projectId}/states/`,
		);
		const doneGroups = new Set(["completed", "cancelled"]);
		const doneStateIds = new Set(allStates.filter((s) => doneGroups.has(s.group)).map((s) => s.id));

		// Check blocking relations for each issue
		const unblocked: PlaneIssue[] = [];
		const blocked: { id: string; name: string; blockers: string[] }[] = [];

		for (const issue of matching) {
			const relations = await fetchAll<PlaneRelation>(
				`/workspaces/${workspaceSlug}/projects/${projectId}/work-items/${issue.id}/relations/`,
			);

			// "blocked_by" means this issue is blocked by the related_issue
			const blockerIds = relations
				.filter((r) => r.relation_type === "blocked_by")
				.map((r) => r.related_issue);

			// Check if blockers are still active (not in a done state)
			const activeBlockers: string[] = [];
			for (const blockerId of blockerIds) {
				try {
					const blocker = await planeGet<PlaneIssue>(
						`/workspaces/${workspaceSlug}/projects/${projectId}/work-items/${blockerId}/`,
					);
					if (!doneStateIds.has(blocker.state)) {
						activeBlockers.push(blockerId);
					}
				} catch (err) {
					// If we can't fetch the blocker, assume it's still active
					logger.warn(`Could not fetch blocker ${blockerId}: ${formatError(err)}`);
					activeBlockers.push(blockerId);
				}
			}

			if (activeBlockers.length === 0) {
				unblocked.push(issue);
			} else {
				blocked.push({ id: issue.id, name: issue.name, blockers: activeBlockers });
			}
		}

		if (unblocked.length === 0) {
			if (blocked.length > 0) {
				logger.warn("No unblocked issues found. Blocked issues:");
				for (const entry of blocked) {
					logger.warn(`  ${entry.name} — blocked by: ${entry.blockers.join(", ")}`);
				}
			}
			return null;
		}

		// Sort by priority: urgent=1 < high=2 < medium=3 < low=4 < none=5
		const sorted = [...unblocked].sort(
			(a, b) => priorityRank(a.priority) - priorityRank(b.priority),
		);

		const issue = sorted[0];
		if (!issue) return null;

		const webUrl = `${getAppUrl()}/${workspaceSlug}/projects/${projectId}/issues/${issue.id}`;
		return {
			id: makeIssueId(workspaceSlug, projectId, issue.id),
			title: issue.name,
			description: issue.description_stripped ?? "",
			url: webUrl,
		};
	}

	async fetchIssueById(id: string): Promise<Issue | null> {
		try {
			const { workspaceSlug, projectId, issueId } = parseIssueId(id);
			const issue = await planeGet<PlaneIssue>(
				`/workspaces/${workspaceSlug}/projects/${projectId}/work-items/${issueId}/`,
			);
			const webUrl = `${getAppUrl()}/${workspaceSlug}/projects/${projectId}/issues/${issue.id}`;

			// Resolve state ID to state name (best-effort)
			let stateName: string | undefined;
			try {
				const states = await fetchAll<PlaneState>(
					`/workspaces/${workspaceSlug}/projects/${projectId}/states/`,
				);
				stateName = states.find((s) => s.id === issue.state)?.name;
			} catch {
				// Non-fatal — status resolution is best-effort
			}

			return {
				id: makeIssueId(workspaceSlug, projectId, issue.id),
				title: issue.name,
				description: issue.description_stripped ?? "",
				url: webUrl,
				status: stateName,
			};
		} catch {
			return null;
		}
	}

	async updateStatus(issueId: string, stateName: string): Promise<void> {
		const { workspaceSlug, projectId, issueId: planeIssueId } = parseIssueId(issueId);
		const stateId = await resolveStateId(workspaceSlug, projectId, stateName);
		await planePatch<PlaneIssue>(
			`/workspaces/${workspaceSlug}/projects/${projectId}/work-items/${planeIssueId}/`,
			{ state: stateId },
		);
	}

	async attachPullRequest(issueId: string, prUrl: string): Promise<void> {
		const { workspaceSlug, projectId, issueId: planeIssueId } = parseIssueId(issueId);
		await planePost<PlaneComment>(
			`/workspaces/${workspaceSlug}/projects/${projectId}/work-items/${planeIssueId}/comments/`,
			{
				comment_html: `<p>Pull request: <a href="${escapeHtml(prUrl)}">${escapeHtml(prUrl)}</a></p>`,
			},
		);
	}

	async completeIssue(issueId: string, stateName: string, labelToRemove?: string): Promise<void> {
		await this.updateStatus(issueId, stateName);
		if (labelToRemove) {
			await this.removeLabel(issueId, labelToRemove);
		}
	}

	async listIssues(config: SourceConfig): Promise<Issue[]> {
		const workspaceSlug = config.scope;
		const projectId = await resolveProjectId(workspaceSlug, config.project);
		const stateId = await resolveStateId(workspaceSlug, projectId, config.pick_from);
		const labelNames = normalizeLabels(config);
		const labelResults = await Promise.allSettled(
			labelNames.map((name) => resolveLabelId(workspaceSlug, projectId, name)),
		);
		const labelIds = labelResults
			.filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled")
			.map((r) => r.value);

		const allIssues = await fetchAll<PlaneIssue>(
			`/workspaces/${workspaceSlug}/projects/${projectId}/work-items/?state=${stateId}&per_page=100`,
		);

		// Filter client-side by state because the Plane API ?state= param is not reliably applied.
		return allIssues
			.filter((i) => i.state === stateId)
			.filter((i) => labelIds.every((lid) => i.labels.includes(lid)))
			.map((i) => {
				const webUrl = `${getAppUrl()}/${workspaceSlug}/projects/${projectId}/issues/${i.id}`;
				return {
					id: makeIssueId(workspaceSlug, projectId, i.id),
					title: i.name,
					description: i.description_stripped ?? "",
					url: webUrl,
				};
			});
	}

	async listProjects(scope: string): Promise<{ value: string; label: string }[]> {
		const projects = await fetchAll<PlaneProject>(`/workspaces/${scope}/projects/`);
		return projects.map((p) => ({ value: p.identifier, label: p.name }));
	}

	async listLabels(scope: string, project?: string): Promise<{ value: string; label: string }[]> {
		if (!project) return [];
		const projectId = await resolveProjectId(scope, project);
		const labels = await fetchAll<PlaneLabel>(`/workspaces/${scope}/projects/${projectId}/labels/`);
		return labels.map((l) => ({ value: l.name, label: l.name }));
	}

	async listStatuses(scope: string, project?: string): Promise<{ value: string; label: string }[]> {
		if (!project) return [];
		const projectId = await resolveProjectId(scope, project);
		const states = await fetchAll<PlaneState>(`/workspaces/${scope}/projects/${projectId}/states/`);
		return states.map((s) => ({ value: s.name, label: `${s.name} (${s.group})` }));
	}

	async removeLabel(issueId: string, labelName: string): Promise<void> {
		const { workspaceSlug, projectId, issueId: planeIssueId } = parseIssueId(issueId);

		const issue = await planeGet<PlaneIssue>(
			`/workspaces/${workspaceSlug}/projects/${projectId}/work-items/${planeIssueId}/`,
		);

		const labels = await fetchLabels(workspaceSlug, projectId);
		const labelObj = labels.find((l) => l.name.toLowerCase() === labelName.toLowerCase());

		if (!labelObj || !issue.labels.includes(labelObj.id)) return;

		const updatedLabels = issue.labels.filter((lid) => lid !== labelObj.id);
		await planePatch<PlaneIssue>(
			`/workspaces/${workspaceSlug}/projects/${projectId}/work-items/${planeIssueId}/`,
			{ labels: updatedLabels },
		);
	}

	async createComment(issueId: string, body: string): Promise<string> {
		const { workspaceSlug, projectId, issueId: planeIssueId } = parseIssueId(issueId);
		const result = await planePost<PlaneComment>(
			`/workspaces/${workspaceSlug}/projects/${projectId}/work-items/${planeIssueId}/comments/`,
			{ comment_html: `<p>${escapeHtml(body)}</p>` },
		);
		return result.id;
	}

	async createIssue(opts: CreateIssueOpts, config: SourceConfig): Promise<string> {
		const workspaceSlug = config.scope;
		const projectId = await resolveProjectId(workspaceSlug, config.project);
		const stateId = await resolveStateId(workspaceSlug, projectId, opts.status);

		// Resolve label IDs
		const labelNames = Array.isArray(opts.label) ? opts.label : [opts.label];
		const labelResults = await Promise.allSettled(
			labelNames.map((name) => resolveLabelId(workspaceSlug, projectId, name)),
		);
		const labelIds = labelResults
			.filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled")
			.map((r) => r.value);

		const body: Record<string, unknown> = {
			name: opts.title,
			description_html: `<p>${escapeHtml(opts.description)}</p>`,
			state: stateId,
			label_ids: labelIds,
		};
		if (opts.order !== undefined) body.priority = opts.order;
		if (opts.parentId) {
			const parent = parseIssueId(opts.parentId);
			body.parent = parent.issueId;
		}

		const issue = await planePost<{ id: string; sequence_id: number }>(
			`/workspaces/${workspaceSlug}/projects/${projectId}/work-items/`,
			body,
		);

		return makeIssueId(workspaceSlug, projectId, issue.id);
	}
}
