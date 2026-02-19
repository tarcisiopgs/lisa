import type { Source, SourceConfig } from "../types.js";

export class TrelloSource implements Source {
	name = "trello" as const;

	buildFetchPrompt(config: SourceConfig): string {
		return `Use the Trello MCP to search for cards with label "${config.label}" on board "${config.team}", list "${config.project}". Return ONLY the card name (title) of the first matching card. If no cards found, return exactly "NO_ISSUES".`;
	}

	buildUpdatePrompt(issueId: string, status: string): string {
		return `Use the Trello MCP to move card "${issueId}" to the "${status}" list.`;
	}

	buildRemoveLabelPrompt(issueId: string, label: string): string {
		return `Use the Trello MCP to remove label "${label}" from card "${issueId}".`;
	}

	parseIssueId(output: string): string | null {
		if (output.includes("NO_ISSUES")) return null;
		const lines = output.trim().split("\n").filter(Boolean);
		return lines[0]?.trim() ?? null;
	}
}
