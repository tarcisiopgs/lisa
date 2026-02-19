import { resolve } from "node:path";
import type { Issue, LisaConfig } from "./types.js";

export function buildImplementPrompt(issue: Issue, config: LisaConfig): string {
	if (config.workflow === "worktree") {
		return buildWorktreePrompt(issue);
	}

	return buildBranchPrompt(issue, config);
}

function buildWorktreePrompt(issue: Issue): string {
	return `You are an autonomous implementation agent. Your job is to implement a single
issue, validate it, commit, and push the branch.

You are already inside the correct repository worktree on the correct branch.
Do NOT create a new branch — just work on the current one.

## Issue

- **ID:** ${issue.id}
- **Title:** ${issue.title}
- **URL:** ${issue.url}

### Description

${issue.description}

## Instructions

1. **Implement**: Follow the issue description exactly:
   - Read all relevant files listed in the description first (if present)
   - Follow the implementation instructions exactly
   - Verify each acceptance criteria (if present)
   - Respect any stack or technical constraints (if present)

2. **Validate**: Run the project's linter/typecheck/tests if available:
   - Check \`package.json\` (or equivalent) for lint, typecheck, check, or test scripts.
   - Run whichever validation scripts exist (e.g., \`npm run lint\`, \`npm run typecheck\`).
   - Fix any errors before proceeding.

3. **Commit & Push**: Make atomic commits with conventional commit messages.
   Push the branch to origin.
   **IMPORTANT — Language rules:**
   - All commit messages MUST be in English.
   - Use conventional commits format: \`feat: ...\`, \`fix: ...\`, \`refactor: ...\`, \`chore: ...\`

## Rules

- **ALL git commits MUST be in English.**
- The issue description may be in any language — read it for context but write all code artifacts in English.
- Do NOT install new dependencies unless the issue explicitly requires it.
- If you get stuck or the issue is unclear, STOP and explain why.
- One issue only. Do not pick up additional issues.
- If the repo has a CLAUDE.md, read it first and follow its conventions.
- Do NOT create pull requests — the caller handles that.
- Do NOT update the issue tracker — the caller handles that.`;
}

function buildBranchPrompt(issue: Issue, config: LisaConfig): string {
	const workspace = resolve(config.workspace);
	const repoEntries = config.repos
		.map((r) => `   - If it says "Repo: ${r.name}" or title starts with "${r.match}" → \`${resolve(workspace, r.path)}\``)
		.join("\n");

	return `You are an autonomous implementation agent. Your job is to implement a single
issue, validate it, commit, and push the branch.

## Issue

- **ID:** ${issue.id}
- **Title:** ${issue.title}
- **URL:** ${issue.url}

### Description

${issue.description}

## Instructions

1. **Identify the repo**: Look at the issue description for relevant files or repo references.
${repoEntries}
   - If it references multiple repos, pick the PRIMARY one (the one with the most files listed).

2. **Create a branch**: From the repo's main branch, create a branch named after the issue
   (e.g., \`feat/${issue.id.toLowerCase()}-short-description\`).

3. **Implement**: Follow the issue description exactly:
   - Read all relevant files listed in the description first (if present)
   - Follow the implementation instructions exactly
   - Verify each acceptance criteria (if present)
   - Respect any stack or technical constraints (if present)

4. **Validate**: Run the project's linter/typecheck/tests if available:
   - Check \`package.json\` (or equivalent) for lint, typecheck, check, or test scripts.
   - Run whichever validation scripts exist (e.g., \`npm run lint\`, \`npm run typecheck\`).
   - Fix any errors before proceeding.

5. **Commit & Push**: Make atomic commits with conventional commit messages.
   Push the branch to origin.
   **IMPORTANT — Language rules:**
   - All commit messages MUST be in English.
   - Use conventional commits format: \`feat: ...\`, \`fix: ...\`, \`refactor: ...\`, \`chore: ...\`

## Rules

- **ALL git commits, branch names MUST be in English.**
- The issue description may be in any language — read it for context but write all code artifacts in English.
- Do NOT modify files outside the target repo.
- Do NOT install new dependencies unless the issue explicitly requires it.
- If you get stuck or the issue is unclear, STOP and explain why.
- One issue only. Do not pick up additional issues.
- If the repo has a CLAUDE.md, read it first and follow its conventions.
- Do NOT create pull requests — the caller handles that.
- Do NOT update the issue tracker — the caller handles that.`;
}
