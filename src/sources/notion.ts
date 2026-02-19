import type { Source, SourceConfig } from "../types.js";

export class NotionSource implements Source {
	name = "notion" as const;

	buildFetchPrompt(config: SourceConfig): string {
		return `Use the Notion MCP to query the database for items with status "${config.status}" and label/tag "${config.label}", ordered by priority. Return ONLY the page title of the first matching item. If no items found, return exactly "NO_ISSUES".`;
	}

	buildUpdatePrompt(issueId: string, status: string): string {
		return `Use the Notion MCP to update the page "${issueId}" status property to "${status}".`;
	}

	buildRemoveLabelPrompt(issueId: string, label: string): string {
		return `Use the Notion MCP to remove the "${label}" tag from page "${issueId}".`;
	}

	parseIssueId(output: string): string | null {
		if (output.includes("NO_ISSUES")) return null;
		// Notion doesn't have structured IDs like Linear — return the first non-empty line
		const lines = output.trim().split("\n").filter(Boolean);
		return lines[0]?.trim() ?? null;
	}
}
