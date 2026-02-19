import type { Source, SourceConfig } from "../types.js";

export class LinearSource implements Source {
	name = "linear" as const;

	buildFetchPrompt(config: SourceConfig): string {
		return `Use the Linear MCP to list issues with label "${config.label}" in the "${config.team}" team, project "${config.project}", status "${config.status}", ordered by priority (urgent first). Return ONLY the issue identifier (e.g. INT-129) of the first issue. If no issues found, return exactly "NO_ISSUES".`;
	}

	buildUpdatePrompt(issueId: string, status: string): string {
		return `Use the Linear MCP to update issue ${issueId} status to "${status}".`;
	}

	buildRemoveLabelPrompt(issueId: string, label: string): string {
		return `Use the Linear MCP to remove label "${label}" from issue ${issueId}.`;
	}

	parseIssueId(output: string): string | null {
		if (output.includes("NO_ISSUES")) return null;
		const match = output.match(/[A-Z]+-\d+/);
		return match?.[0] ?? null;
	}
}
