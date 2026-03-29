import * as logger from "../output/logger.js";
import type { CreateIssueOpts, Issue, Source, SourceConfig } from "../types/index.js";
import { createApiClient, normalizeLabels } from "./base.js";

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

function getAuthHeaders(): Record<string, string> {
	const email = process.env.JIRA_EMAIL;
	const token = process.env.JIRA_API_TOKEN;
	if (!email || !token) throw new Error("JIRA_EMAIL and JIRA_API_TOKEN must be set");
	const credentials = Buffer.from(`${email}:${token}`).toString("base64");
	return {
		Authorization: `Basic ${credentials}`,
		Accept: "application/json",
	};
}

let _api: ReturnType<typeof createApiClient> | null = null;

function api() {
	if (!_api) _api = createApiClient(`${getBaseUrl()}/rest/api/3`, getAuthHeaders, "Jira");
	return _api;
}

function jiraGet<T>(path: string): Promise<T> {
	return api().get<T>(path);
}

function jiraPost<T>(path: string, body?: unknown): Promise<T> {
	return api().post<T>(path, body);
}

function jiraPut<T>(path: string, body?: unknown): Promise<T> {
	return api().put<T>(path, body);
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

/** Escape special characters in JQL string literals to prevent JQL injection. */
function escapeJql(value: string): string {
	return value
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/'/g, "\\'")
		.replace(/[\n\r\t]/g, " ");
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
		const labels = normalizeLabels(config);
		const labelClause = labels.map((l) => `labels = "${escapeJql(l)}"`).join(" AND ");

		// Resolve status name → ID to avoid locale/translation issues in JQL
		const statusId = await resolveStatusId(config.scope, config.pick_from);
		const statusClause = statusId
			? `status = ${statusId}`
			: `status = "${escapeJql(config.pick_from)}"`;
		const jql = `project = "${escapeJql(config.scope)}" AND ${labelClause} AND ${statusClause} ORDER BY priority ASC, created ASC`;
		const fields = "summary,description,priority,status,labels,issuelinks";

		const issues: JiraIssue[] = [];
		let startAt = 0;
		const pageSize = 50;

		while (true) {
			const data = await jiraPost<JiraSearchResult>("/search/jql", {
				jql,
				fields: fields.split(","),
				maxResults: pageSize,
				startAt,
			});
			const batch = data.issues ?? [];
			issues.push(...batch);
			if (batch.length < pageSize || issues.length >= data.total) break;
			startAt += batch.length;
		}

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
		const labels = normalizeLabels(config);
		const labelClause = labels.map((l) => `labels = "${escapeJql(l)}"`).join(" AND ");

		// Resolve status name → ID to avoid locale/translation issues in JQL
		const statusId = await resolveStatusId(config.scope, config.pick_from);
		const statusClause = statusId
			? `status = ${statusId}`
			: `status = "${escapeJql(config.pick_from)}"`;
		const jql = `project = "${escapeJql(config.scope)}" AND ${labelClause} AND ${statusClause} ORDER BY priority ASC, created ASC`;
		const fields = "summary,description,priority,status,labels";

		const allIssues: JiraIssue[] = [];
		let startAt = 0;
		const pageSize = 100;

		while (true) {
			const data = await jiraPost<JiraSearchResult>("/search/jql", {
				jql,
				fields: fields.split(","),
				maxResults: pageSize,
				startAt,
			});
			const batch = data.issues ?? [];
			allIssues.push(...batch);
			if (batch.length < pageSize || allIssues.length >= data.total) break;
			startAt += batch.length;
		}

		const baseUrl = getBaseUrl();
		return allIssues.map((issue) => ({
			id: issue.key,
			title: issue.fields.summary,
			description: extractDescription(issue.fields.description),
			url: issueUrl(baseUrl, issue.key),
		}));
	}

	async listScopes(): Promise<{ value: string; label: string }[]> {
		const results: { key: string; name: string }[] = [];
		let startAt = 0;
		const pageSize = 50;

		while (true) {
			const data = await jiraGet<{
				values: { key: string; name: string }[];
				total: number;
			}>(`/project/search?maxResults=${pageSize}&startAt=${startAt}`);
			const batch = data.values ?? [];
			results.push(...batch);
			if (batch.length < pageSize || results.length >= data.total) break;
			startAt += batch.length;
		}

		return results.map((p) => ({
			value: p.key,
			label: `${p.key} — ${p.name}`,
		}));
	}

	async listLabels(): Promise<{ value: string; label: string }[]> {
		const results: string[] = [];
		let startAt = 0;
		const pageSize = 100;

		while (true) {
			const data = await jiraGet<{ values: string[]; total: number }>(
				`/label?maxResults=${pageSize}&startAt=${startAt}`,
			);
			const batch = data.values ?? [];
			results.push(...batch);
			if (batch.length < pageSize || results.length >= data.total) break;
			startAt += batch.length;
		}

		return results.map((l) => ({
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

	async createIssue(opts: CreateIssueOpts, config: SourceConfig): Promise<string> {
		const labels = Array.isArray(opts.label) ? opts.label : [opts.label];

		const fields: Record<string, unknown> = {
			project: { key: config.scope },
			summary: opts.title,
			description: {
				type: "doc",
				version: 1,
				content: [
					{
						type: "paragraph",
						content: [{ type: "text", text: opts.description }],
					},
				],
			},
			issuetype: { name: "Task" },
			labels,
		};

		if (opts.parentId) fields.parent = { key: opts.parentId };

		const result = await jiraPost<{ key: string }>("/issue", { fields });

		// Transition to the desired status if specified
		if (opts.status) {
			try {
				await this.updateStatus(result.key, opts.status);
			} catch {
				// Non-fatal — issue was created, status transition may not be available
			}
		}

		return result.key;
	}

	async linkDependency(issueId: string, dependsOnId: string): Promise<void> {
		await jiraPost("/issueLink", {
			type: { name: "Blocks" },
			inwardIssue: { key: dependsOnId },
			outwardIssue: { key: issueId },
		});
	}
}

function parseJiraIdentifier(input: string): string {
	// Extract issue key from Jira URL: https://domain.atlassian.net/browse/ENG-123
	const urlMatch = input.match(/\/browse\/([A-Z][A-Z0-9_]+-\d+)/);
	if (urlMatch?.[1]) return urlMatch[1];

	// Already a key like ENG-123
	return input;
}
