import { resolve } from "node:path";
import { buildContextMdBlock } from "../prompt.js";
import { readContext } from "../session/context-manager.js";
import type { LisaConfig } from "../types/index.js";
import { detectLanguage, languageName } from "./language.js";

/**
 * Build a prompt that asks the AI to decompose a goal into atomic issues.
 * Returns structured JSON for parsing.
 */
export function buildPlanningPrompt(
	goal: string,
	config: LisaConfig,
	parentIssueDescription?: string,
): string {
	const language = detectLanguage(goal);
	const workspace = resolve(config.workspace);
	const contextMd = readContext(workspace);
	const contextBlock = buildContextMdBlock(contextMd);

	const repoBlock =
		config.repos.length > 0
			? config.repos
					.map(
						(r) =>
							`- **${r.name}**: \`${resolve(workspace, r.path)}\` (base: \`${r.base_branch}\`)`,
					)
					.join("\n")
			: `- **${workspace}** (single-repo, base: \`${config.base_branch}\`)`;

	const parentBlock = parentIssueDescription
		? `\n## Parent Issue Description\n\n${parentIssueDescription}\n`
		: "";

	return `You are a project planning agent. Your job is to decompose a high-level goal into atomic, implementable issues.

## Goal

${goal}
${parentBlock}
## Available Repositories

${repoBlock}
${contextBlock}
## Instructions

Analyze the goal and the codebase context above. Decompose the goal into **2-8 atomic issues** that can each be completed in a single AI coding session (under 1 hour of agent work).

For each issue, provide:
- **title**: Short, descriptive title (imperative: "Add X", "Fix Y", "Create Z")
- **description**: Full markdown description with context, approach, and acceptance criteria as a \`- [ ]\` checklist
- **acceptanceCriteria**: Array of the checklist items as plain strings
- **relevantFiles**: Array of file paths in the codebase that will be modified or created
- **order**: Integer (1-based) — execution order based on dependencies
- **dependsOn**: Array of order numbers this issue depends on (empty if independent)
${config.repos.length > 1 ? "- **repo**: Name of the target repository from the list above (required for multi-repo)\n" : ""}
## Language

Respond in ${languageName(language)}. Generate all issue titles, descriptions, and acceptance criteria in ${languageName(language)}.

## Rules

1. Each issue MUST be self-contained and completable in a single session
2. Each issue MUST have at least 2 acceptance criteria
3. Each issue MUST reference specific file paths (existing or to be created)
4. Issues MUST include test expectations in their acceptance criteria
5. Order issues so dependencies come first (lower order = executes first)
6. Use clear, specific titles — not vague ("Improve X" is bad, "Add rate limit middleware to /api/users" is good)
7. Output ONLY valid JSON — no markdown code fences, no explanation text

## Output Format

Respond with ONLY this JSON structure (no wrapping, no markdown):

{"issues":[{"title":"...","description":"...","acceptanceCriteria":["..."],"relevantFiles":["..."],"order":1,"dependsOn":[]${config.repos.length > 1 ? ',"repo":"..."' : ""}}]}`;
}
