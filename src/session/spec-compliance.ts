import { execa } from "execa";
import type {
	Issue,
	SpecComplianceConfig,
	SpecComplianceCriterion,
	SpecComplianceResult,
} from "../types/index.js";

/**
 * Extracts acceptance criteria from an issue description.
 * Looks for markdown checklists, numbered lists under "acceptance criteria" headers,
 * and "should"/"deve" statements.
 */
export function extractAcceptanceCriteria(description: string): string[] {
	const criteria: string[] = [];

	// Extract markdown checklist items: - [ ] Something
	const checklistRegex = /^[\t ]*- \[ \]\s*(.+)$/gm;
	let match: RegExpExecArray | null;
	match = checklistRegex.exec(description);
	while (match) {
		if (match[1]) criteria.push(match[1].trim());
		match = checklistRegex.exec(description);
	}

	if (criteria.length > 0) return criteria;

	// Fallback: extract lines under "Acceptance Criteria" / "Critérios de Aceite" header
	const headerRegex = /(?:acceptance criteria|critérios de aceite|expected behavior)[:\s]*\n/i;
	const headerMatch = headerRegex.exec(description);
	if (headerMatch) {
		const afterHeader = description.slice(headerMatch.index + headerMatch[0].length);
		const lines = afterHeader.split("\n");
		for (const line of lines) {
			const trimmed = line.trim();
			// Stop at next header or empty line after content
			if (trimmed.startsWith("#") || trimmed.startsWith("---")) break;
			// Capture list items
			const listMatch = /^[-*]\s+(.+)$/.exec(trimmed);
			if (listMatch?.[1]) {
				criteria.push(listMatch[1].trim());
			}
			const numberedMatch = /^\d+[.)]\s+(.+)$/.exec(trimmed);
			if (numberedMatch?.[1]) {
				criteria.push(numberedMatch[1].trim());
			}
		}
	}

	return criteria;
}

/**
 * Gets the full git diff (not just stat) for spec compliance analysis.
 * Truncates to avoid exceeding LLM context limits.
 */
export async function getFullDiff(
	cwd: string,
	baseBranch: string,
	maxChars = 30_000,
): Promise<string> {
	try {
		const { stdout } = await execa("git", ["diff", `${baseBranch}..HEAD`], {
			cwd,
			reject: false,
		});
		const diff = stdout.trim();
		if (diff.length <= maxChars) return diff;
		return `${diff.slice(0, maxChars)}\n\n[... diff truncated at ${maxChars} characters ...]`;
	} catch {
		return "";
	}
}

/**
 * Builds the spec compliance verification prompt.
 * The agent responds with JSON — no code changes.
 */
export function buildCompliancePrompt(issue: Issue, criteria: string[], diff: string): string {
	const criteriaList = criteria.map((c, i) => `${i + 1}. ${c}`).join("\n");

	return `You are a spec compliance validator. Your ONLY task is to check if an implementation satisfies the acceptance criteria. Do NOT modify any files or run any commands.

## Issue
${issue.id}: ${issue.title}

## Acceptance Criteria
${criteriaList}

## Implementation (git diff)
\`\`\`diff
${diff}
\`\`\`

## Task
For each acceptance criterion above, determine if the implementation (git diff) satisfies it.

Respond with ONLY a valid JSON object — no markdown fences, no explanation, no other text:

{
  "criteria": [
    { "criterion": "the criterion text", "met": true, "evidence": "brief explanation of how it's met" },
    { "criterion": "the criterion text", "met": false, "evidence": "what is missing or wrong" }
  ],
  "summary": "X/Y criteria met",
  "passed": false
}

IMPORTANT:
- Do NOT create, edit, or modify any files.
- Do NOT run any shell commands.
- Do NOT create branches or commits.
- ONLY output the JSON object above.`;
}

/**
 * Builds a recovery prompt when spec compliance fails.
 * This one tells the agent to fix the unmet criteria.
 */
export function buildComplianceRecoveryPrompt(
	issue: Issue,
	unmetCriteria: SpecComplianceCriterion[],
): string {
	const unmetList = unmetCriteria
		.map((c, i) => `${i + 1}. **${c.criterion}**\n   Reason: ${c.evidence}`)
		.join("\n\n");

	return `You are continuing work on issue ${issue.id}: "${issue.title}".

Your implementation was checked against the acceptance criteria and the following were NOT met:

${unmetList}

Fix ONLY the unmet criteria above. Commit and push your changes.

IMPORTANT:
- Do NOT create a new branch — you are already on the correct branch.
- Fix ONLY the unmet criteria listed above.
- Commit and push your fixes.
- Do NOT create a PR — that will be handled separately.`;
}

/**
 * Parses the spec compliance JSON response from the agent.
 * Resilient to markdown fences and extra text around the JSON.
 */
export function parseComplianceResponse(output: string): SpecComplianceResult | null {
	// Try to extract JSON from the output (agent might wrap it in markdown fences or add text)
	const jsonPatterns = [
		// Direct JSON object
		/\{[\s\S]*"criteria"[\s\S]*\}/,
		// Inside markdown code fence
		/```(?:json)?\s*(\{[\s\S]*"criteria"[\s\S]*\})\s*```/,
	];

	for (const pattern of jsonPatterns) {
		const match = pattern.exec(output);
		if (match) {
			const jsonStr = match[1] ?? match[0];
			try {
				const parsed = JSON.parse(jsonStr) as SpecComplianceResult;
				if (Array.isArray(parsed.criteria)) {
					// Recompute passed based on actual criteria
					const allMet = parsed.criteria.every((c) => c.met);
					return {
						criteria: parsed.criteria,
						passed: allMet,
						summary:
							parsed.summary ||
							`${parsed.criteria.filter((c) => c.met).length}/${parsed.criteria.length} criteria met`,
					};
				}
			} catch {
				// Try next pattern
			}
		}
	}

	return null;
}

/**
 * Returns true if spec_compliance is enabled in config.
 */
export function isSpecComplianceEnabled(config?: SpecComplianceConfig): boolean {
	return config?.enabled === true;
}

/**
 * Formats spec compliance results as a Markdown section for the PR body.
 */
export function formatSpecCompliance(result: SpecComplianceResult): string {
	const lines: string[] = ["", "---", "## Spec Compliance", ""];
	lines.push(`**${result.summary}**`);
	lines.push("");
	lines.push("| Criterion | Status | Evidence |");
	lines.push("|-----------|--------|----------|");

	for (const c of result.criteria) {
		const status = c.met ? "Met" : "Not Met";
		const evidence = c.evidence.replace(/\|/g, "\\|").replace(/\n/g, " ");
		const criterion = c.criterion.replace(/\|/g, "\\|").replace(/\n/g, " ");
		lines.push(`| ${criterion} | ${status} | ${evidence} |`);
	}

	return lines.join("\n");
}
