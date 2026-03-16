import * as logger from "../output/logger.js";
import type { Issue, Source, SourceConfig } from "../types/index.js";

const REQUEST_TIMEOUT_MS = 30_000;

const PRIORITY_RANK: Record<string, number> = {
	highest: 1,
	high: 2,
	medium: 3,
	low: 4,
	lowest: 5,
};

function getBaseUrl(): string {
	const url = process.env.JIRA_BASE_URL;
	if (!url) throw new Error("JIRA_BASE_URL is not set");
	return url.replace(/\/$/, "");
}

function getAuthHeader(): string {
	const email = process.env.JIRA_EMAIL;
	const token = process.env.JIRA_API_TOKEN;
	if (!email || !token) throw new Error("JIRA_EMAIL and JIRA_API_TOKEN must be set");
	const credentials = Buffer.from(`${email}:${token}`).toString("base64");
	return `Basic ${credentials}`;
}

async function jiraFetch<T>(method: string, path: string, body?: unknown): Promise<T> {
	const url = `${getBaseUrl()}/rest/api/3${path}`;
	const res = await fetch(url, {
		method,
		headers: {
			Authorization: getAuthHeader(),
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: body !== undefined ? JSON.stringify(body) : undefined,
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Jira API error (${res.status}): ${text}`);
	}

	if (res.status === 204) return undefined as T;
	return (await res.json()) as T;
}

async function jiraGet<T>(path: string): Promise<T> {
	return jiraFetch<T>("GET", path);
}

async function jiraPost<T>(path: string, body: unknown): Promise<T> {
	return jiraFetch<T>("POST", path, body);
}

async function jiraPut<T>(path: string, body: unknown): Promise<T> {
	return jiraFetch<T>("PUT", path, body);
}

async function jiraSearchJql<T>(jql: string, fields: string, maxResults: number): Promise<T> {
	return jiraPost<T>("/search/jql", { jql, fields: fields.split(","), maxResults });
}

interface JiraIssueLink {
	type: { name: string; inward: string; outward: string };
	inwardIssue?: {
		key: string;
		fields: { status: { name: string; statusCategory: { key: string } } };
	};
	outwardIssue?: {
		key: string;
		fields: { status: { name: string; statusCategory: { key: string } } };
	};
}

interface JiraIssue {
	id: string;
	key: string;
	self: string;
	fields: {
		summary: string;
		description: unknown;
		priority: { name: string } | null;
		status: { name: string };
		labels: string[];
		issuelinks?: JiraIssueLink[];
	};
}

interface JiraSearchResult {
	issues: JiraIssue[];
	total: number;
}

interface JiraStatus {
	id: string;
	name: string;
}

interface JiraIssueTypeStatuses {
	statuses: JiraStatus[];
}

interface JiraTransition {
	id: string;
	name: string;
	to: { id: string; name: string };
}

interface JiraTransitionsResult {
	transitions: JiraTransition[];
}

function priorityRank(issue: JiraIssue): number {
	const name = issue.fields.priority?.name?.toLowerCase() ?? "";
	return PRIORITY_RANK[name] ?? Number.MAX_SAFE_INTEGER;
}

function extractDescription(description: unknown): string {
	if (!description) return "";
	if (typeof description === "string") return description;
	// Jira API v3 uses Atlassian Document Format (ADF) — extract plain text
	if (typeof description === "object") {
		return extractAdfText(description as Record<string, unknown>);
	}
	return "";
}

function extractAdfText(node: Record<string, unknown>): string {
	if (node.type === "text" && typeof node.text === "string") return node.text;

	const parts: string[] = [];
	if (Array.isArray(node.content)) {
		for (const child of node.content as Record<string, unknown>[]) {
			const text = extractAdfText(child);
			if (text) parts.push(text);
		}
	}
	return parts.join("\n");
}

/** Escape double quotes in JQL string literals to prevent JQL injection. */
function escapeJql(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Resolve a status name to its numeric ID via the project statuses endpoint. */
async function resolveStatusId(scope: string, statusName: string): Promise<string | null> {
	try {
		const data = await jiraGet<JiraIssueTypeStatuses[]>(
			`/project/${encodeURIComponent(scope)}/statuses`,
		);
		for (const issueType of data) {
			const match = issueType.statuses.find(
				(s) => s.name.toLowerCase() === statusName.toLowerCase(),
			);
			if (match) return match.id;
		}
	} catch {
		// Fall through to null — caller will use status name in JQL as fallback
	}
	return null;
}

function issueUrl(baseUrl: string, key: string): string {
	return `${baseUrl}/browse/${key}`;
}

export class JiraSource implements Source {
	name = "jira" as const;

	async fetchNextIssue(config: SourceConfig): Promise<Issue | null> {
		const labels = Array.isArray(config.label) ? config.label : [config.label];
		const labelClause = labels.map((l) => `labels = "${escapeJql(l)}"`).join(" AND ");

		// Resolve status name → ID to avoid locale/translation issues in JQL
		const statusId = await resolveStatusId(config.scope, config.pick_from);
		const statusClause = statusId
			? `status = ${statusId}`
			: `status = "${escapeJql(config.pick_from)}"`;
		const jql = `project = "${escapeJql(config.scope)}" AND ${labelClause} AND ${statusClause} ORDER BY priority ASC, created ASC`;
		const fields = "summary,description,priority,status,labels,issuelinks";

		const data = await jiraSearchJql<JiraSearchResult>(jql, fields, 50);

		const issues = data.issues ?? [];
		if (issues.length === 0) return null;

		// Check blocking relations for each issue
		const unblocked: JiraIssue[] = [];
		const blocked: { key: string; blockers: string[] }[] = [];

		for (const issue of issues) {
			const activeBlockers = (issue.fields.issuelinks ?? [])
				.filter((link) => {
					// "inwardIssue" with inward description containing "is blocked by"
					// means this issue is blocked by the inwardIssue
					if (link.inwardIssue && link.type.inward.toLowerCase().includes("is blocked by")) {
						return link.inwardIssue.fields.status.statusCategory.key !== "done";
					}
					// "outwardIssue" with outward description "blocks" means nothing for *this* issue
					// (this issue blocks the outward one, not the other way around)
					return false;
				})
				.map((link) => link.inwardIssue?.key ?? "");

			if (activeBlockers.length === 0) {
				unblocked.push(issue);
			} else {
				blocked.push({ key: issue.key, blockers: activeBlockers });
			}
		}

		if (unblocked.length === 0) {
			if (blocked.length > 0) {
				logger.warn("No unblocked issues found. Blocked issues:");
				for (const entry of blocked) {
					logger.warn(`  ${entry.key} — blocked by: ${entry.blockers.join(", ")}`);
				}
			}
			return null;
		}

		// Sort by Jira priority (Highest=1 → Lowest=5, no priority=max)
		const sorted = [...unblocked].sort((a, b) => priorityRank(a) - priorityRank(b));

		const issue = sorted[0];
		if (!issue) return null;

		const baseUrl = getBaseUrl();
		return {
			id: issue.key,
			title: issue.fields.summary,
			description: extractDescription(issue.fields.description),
			url: issueUrl(baseUrl, issue.key),
		};
	}

	async fetchIssueById(id: string): Promise<Issue | null> {
		const key = parseJiraIdentifier(id);
		try {
			const issue = await jiraGet<JiraIssue>(
				`/issue/${key}?fields=summary,description,priority,status,labels`,
			);
			const baseUrl = getBaseUrl();
			return {
				id: issue.key,
				title: issue.fields.summary,
				description: extractDescription(issue.fields.description),
				url: issueUrl(baseUrl, issue.key),
				status: issue.fields.status.name,
			};
		} catch {
			return null;
		}
	}

	async updateStatus(issueId: string, statusName: string): Promise<void> {
		const key = parseJiraIdentifier(issueId);
		const data = await jiraGet<JiraTransitionsResult>(`/issue/${key}/transitions`);

		// Match by target status name first (what the user sees), then by transition name
		const lowerName = statusName.toLowerCase();
		const transition =
			data.transitions.find((t) => t.to.name.toLowerCase() === lowerName) ??
			data.transitions.find((t) => t.name.toLowerCase() === lowerName);
		if (!transition) {
			const available = data.transitions.map((t) => `${t.name} → ${t.to.name}`).join(", ");
			throw new Error(`Jira transition "${statusName}" not found. Available: ${available}`);
		}

		await jiraPost(`/issue/${key}/transitions`, { transition: { id: transition.id } });
	}

	async attachPullRequest(issueId: string, prUrl: string): Promise<void> {
		const key = parseJiraIdentifier(issueId);
		await jiraPost(`/issue/${key}/remotelink`, {
			object: {
				url: prUrl,
				title: "Pull Request",
				icon: {
					url16x16: "https://github.com/favicon.ico",
					title: "GitHub",
				},
			},
		});
	}

	async completeIssue(issueId: string, statusName: string, labelToRemove?: string): Promise<void> {
		await this.updateStatus(issueId, statusName);
		if (labelToRemove) {
			await this.removeLabel(issueId, labelToRemove);
		}
	}

	async listIssues(config: SourceConfig): Promise<Issue[]> {
		const labels = Array.isArray(config.label) ? config.label : [config.label];
		const labelClause = labels.map((l) => `labels = "${escapeJql(l)}"`).join(" AND ");

		// Resolve status name → ID to avoid locale/translation issues in JQL
		const statusId = await resolveStatusId(config.scope, config.pick_from);
		const statusClause = statusId
			? `status = ${statusId}`
			: `status = "${escapeJql(config.pick_from)}"`;
		const jql = `project = "${escapeJql(config.scope)}" AND ${labelClause} AND ${statusClause} ORDER BY priority ASC, created ASC`;
		const fields = "summary,description,priority,status,labels";

		const data = await jiraSearchJql<JiraSearchResult>(jql, fields, 100);

		const baseUrl = getBaseUrl();
		return (data.issues ?? []).map((issue) => ({
			id: issue.key,
			title: issue.fields.summary,
			description: extractDescription(issue.fields.description),
			url: issueUrl(baseUrl, issue.key),
		}));
	}

	async listScopes(): Promise<{ value: string; label: string }[]> {
		const data = await jiraGet<{ values: { key: string; name: string }[] }>(
			"/project/search?maxResults=50",
		);
		return (data.values ?? []).map((p) => ({
			value: p.key,
			label: `${p.key} — ${p.name}`,
		}));
	}

	async listLabels(): Promise<{ value: string; label: string }[]> {
		const data = await jiraGet<{ values: string[] }>("/label?maxResults=100");
		return (data.values ?? []).map((l) => ({
			value: l,
			label: l,
		}));
	}

	async listStatuses(scope: string): Promise<{ value: string; label: string }[]> {
		const data = await jiraGet<{ statuses: { name: string }[] }[]>(
			`/project/${encodeURIComponent(scope)}/statuses`,
		);
		const seen = new Set<string>();
		const results: { value: string; label: string }[] = [];
		for (const issueType of data) {
			for (const status of issueType.statuses) {
				if (!seen.has(status.name)) {
					seen.add(status.name);
					results.push({ value: status.name, label: status.name });
				}
			}
		}
		return results;
	}

	async removeLabel(issueId: string, labelName: string): Promise<void> {
		const key = parseJiraIdentifier(issueId);
		const issue = await jiraGet<JiraIssue>(`/issue/${key}?fields=labels`);

		const currentLabels = issue.fields.labels ?? [];
		const filtered = currentLabels.filter((l) => l.toLowerCase() !== labelName.toLowerCase());

		if (filtered.length === currentLabels.length) return;

		await jiraPut(`/issue/${key}`, { fields: { labels: filtered } });
	}
}

function parseJiraIdentifier(input: string): string {
	// Extract issue key from Jira URL: https://domain.atlassian.net/browse/ENG-123
	const urlMatch = input.match(/\/browse\/([A-Z][A-Z0-9_]+-\d+)/);
	if (urlMatch?.[1]) return urlMatch[1];

	// Already a key like ENG-123
	return input;
}
