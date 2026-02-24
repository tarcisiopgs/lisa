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
	};
}

interface JiraSearchResult {
	issues: JiraIssue[];
	total: number;
}

interface JiraTransition {
	id: string;
	name: string;
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

function issueUrl(baseUrl: string, key: string): string {
	return `${baseUrl}/browse/${key}`;
}

export class JiraSource implements Source {
	name = "jira" as const;

	async fetchNextIssue(config: SourceConfig): Promise<Issue | null> {
		const jql = encodeURIComponent(
			`project = "${config.team}" AND labels = "${config.label}" AND status = "${config.pick_from}" ORDER BY priority ASC, created ASC`,
		);
		const fields = "summary,description,priority,status,labels";

		const data = await jiraGet<JiraSearchResult>(
			`/search?jql=${jql}&fields=${fields}&maxResults=50`,
		);

		const issues = data.issues ?? [];
		if (issues.length === 0) return null;

		// Sort by Jira priority (Highest=1 → Lowest=5, no priority=max)
		const sorted = [...issues].sort((a, b) => priorityRank(a) - priorityRank(b));

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
			};
		} catch {
			return null;
		}
	}

	async updateStatus(issueId: string, statusName: string): Promise<void> {
		const key = parseJiraIdentifier(issueId);
		const data = await jiraGet<JiraTransitionsResult>(`/issue/${key}/transitions`);

		const transition = data.transitions.find(
			(t) => t.name.toLowerCase() === statusName.toLowerCase(),
		);
		if (!transition) {
			const available = data.transitions.map((t) => t.name).join(", ");
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
