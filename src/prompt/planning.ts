import { resolve } from "node:path";
import { getPlanPath } from "../paths.js";
import type { Issue, LisaConfig } from "../types/index.js";
import { buildContextMdBlock } from "./shared.js";

export function buildPlanningPrompt(
	issue: Issue,
	config: LisaConfig,
	planPath?: string,
	globalContextMd?: string | null,
): string {
	const workspace = resolve(config.workspace);

	const repoBlock = config.repos
		.map((r) => {
			const absPath = resolve(workspace, r.path);
			return `- **${r.name}**: \`${absPath}\` (base branch: \`${r.base_branch}\`)`;
		})
		.join("\n");

	const resolvedPlanPath = planPath ?? getPlanPath(workspace);
	const globalContextBlock = buildContextMdBlock(globalContextMd ?? null);

	return `You are an issue analysis agent. Your job is to read the issue below, determine which repositories are affected, and produce an execution plan.

**Do NOT implement anything.** Only analyze the issue and produce the plan file.

## Issue

- **ID:** ${issue.id}
- **Title:** ${issue.title}
- **URL:** ${issue.url}

### Description

${issue.description}

## Available Repositories

${repoBlock}
${globalContextBlock}
## Instructions

1. **Analyze the issue**: Read the title and description carefully. Determine which repositories above are affected by this change.
   Consider:
   - File paths or module names mentioned in the description
   - Technologies and frameworks referenced
   - Dependencies between repos (e.g., backend API changes needed before frontend can consume them)

2. **Determine execution order**: If multiple repos are affected, decide the order. Repos that produce APIs, schemas, or shared libraries should come first. Repos that consume them should come later.

3. **Write the plan file to disk**: Use a bash command or file-write tool to write the plan to \`${resolvedPlanPath}\`.
   **You MUST write the file to disk. Do NOT print the JSON to stdout or in a code block.**

   The file must be valid JSON with this structure (replace angle-bracket placeholders with real values):
   - \`repoPath\`: absolute path to the affected repository
   - \`scope\`: concise English description of what to implement in that repo
   - \`order\`: integer starting at 1 (lower = executes first)

   Use your write_file tool, or a bash command such as:
   \`\`\`bash
   printf '%s' '{"steps":[{"repoPath":"/absolute/path","scope":"description of work","order":1}]}' > '${resolvedPlanPath}'
   \`\`\`

## Rules

- Only include repos that are actually affected by the issue. Do NOT include repos that don't need changes.
- The \`scope\` field should be a concise English description of what needs to be done in that specific repo.
- Order matters: lower order numbers execute first.
- Do NOT implement anything. Do NOT create branches, write code, or commit.
- If only one repo is affected, the plan should have a single step.`;
}
