import type { Issue, Source, SourceConfig } from "../types/index.js";

const DEFAULT_BASE_URL = "https://api.plane.so";
const REQUEST_TIMEOUT_MS = 30_000;

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
	if (!token) throw new Error("PLANE_API_TOKEN must be set");
	return { "X-Api-Key": token };
}

async function planeFetch<T>(method: string, path: string, body?: unknown): Promise<T> {
	const url = `${getBaseUrl()}/api/v1${path}`;
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
		throw new Error(`Plane API error (${res.status}): ${text}`);
	}

	if (method === "DELETE" || res.status === 204) return undefined as T;
	return (await res.json()) as T;
}

async function planeGet<T>(path: string): Promise<T> {
	return planeFetch<T>("GET", path);
}

async function planePatch<T>(path: string, body: unknown): Promise<T> {
	return planeFetch<T>("PATCH", path, body);
}

async function planePost<T>(path: string, body: unknown): Promise<T> {
	return planeFetch<T>("POST", path, body);
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
	label_ids: string[];
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

// Handles both paginated ({ results: T[] }) and plain array responses
async function fetchAll<T>(path: string): Promise<T[]> {
	const data = await planeGet<T[] | PlanePage<T>>(path);
	if (Array.isArray(data)) return data;
	return data.results ?? [];
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
		const workspaceSlug = config.team;
		const projectId = await resolveProjectId(workspaceSlug, config.project);
		const stateId = await resolveStateId(workspaceSlug, projectId, config.pick_from);
		const labelNames = Array.isArray(config.label) ? config.label : [config.label];
		const labelIds = await Promise.all(
			labelNames.map((name) => resolveLabelId(workspaceSlug, projectId, name)),
		);

		const data = await planeGet<PlanePage<PlaneIssue>>(
			`/workspaces/${workspaceSlug}/projects/${projectId}/issues/?state=${stateId}&per_page=100`,
		);

		const matching = data.results.filter((i) => labelIds.every((lid) => i.label_ids.includes(lid)));
		if (matching.length === 0) return null;

		// Sort by priority: urgent=1 < high=2 < medium=3 < low=4 < none=5
		const sorted = [...matching].sort(
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
				`/workspaces/${workspaceSlug}/projects/${projectId}/issues/${issueId}/`,
			);
			const webUrl = `${getAppUrl()}/${workspaceSlug}/projects/${projectId}/issues/${issue.id}`;
			return {
				id: makeIssueId(workspaceSlug, projectId, issue.id),
				title: issue.name,
				description: issue.description_stripped ?? "",
				url: webUrl,
			};
		} catch {
			return null;
		}
	}

	async updateStatus(issueId: string, stateName: string): Promise<void> {
		const { workspaceSlug, projectId, issueId: planeIssueId } = parseIssueId(issueId);
		const stateId = await resolveStateId(workspaceSlug, projectId, stateName);
		await planePatch<PlaneIssue>(
			`/workspaces/${workspaceSlug}/projects/${projectId}/issues/${planeIssueId}/`,
			{ state: stateId },
		);
	}

	async attachPullRequest(issueId: string, prUrl: string): Promise<void> {
		const { workspaceSlug, projectId, issueId: planeIssueId } = parseIssueId(issueId);
		await planePost<PlaneComment>(
			`/workspaces/${workspaceSlug}/projects/${projectId}/issues/${planeIssueId}/comments/`,
			{ comment_html: `<p>Pull request: <a href="${prUrl}">${prUrl}</a></p>` },
		);
	}

	async completeIssue(issueId: string, stateName: string, labelToRemove?: string): Promise<void> {
		await this.updateStatus(issueId, stateName);
		if (labelToRemove) {
			await this.removeLabel(issueId, labelToRemove);
		}
	}

	async listIssues(config: SourceConfig): Promise<Issue[]> {
		const workspaceSlug = config.team;
		const projectId = await resolveProjectId(workspaceSlug, config.project);
		const stateId = await resolveStateId(workspaceSlug, projectId, config.pick_from);
		const labelNames = Array.isArray(config.label) ? config.label : [config.label];
		const labelIds = await Promise.all(
			labelNames.map((name) => resolveLabelId(workspaceSlug, projectId, name)),
		);

		const data = await planeGet<PlanePage<PlaneIssue>>(
			`/workspaces/${workspaceSlug}/projects/${projectId}/issues/?state=${stateId}&per_page=100`,
		);

		return data.results
			.filter((i) => labelIds.every((lid) => i.label_ids.includes(lid)))
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

	async removeLabel(issueId: string, labelName: string): Promise<void> {
		const { workspaceSlug, projectId, issueId: planeIssueId } = parseIssueId(issueId);

		const issue = await planeGet<PlaneIssue>(
			`/workspaces/${workspaceSlug}/projects/${projectId}/issues/${planeIssueId}/`,
		);

		const labels = await fetchLabels(workspaceSlug, projectId);
		const labelObj = labels.find((l) => l.name.toLowerCase() === labelName.toLowerCase());

		if (!labelObj || !issue.label_ids.includes(labelObj.id)) return;

		const updatedLabelIds = issue.label_ids.filter((lid) => lid !== labelObj.id);
		await planePatch<PlaneIssue>(
			`/workspaces/${workspaceSlug}/projects/${projectId}/issues/${planeIssueId}/`,
			{ label_ids: updatedLabelIds },
		);
	}
}
