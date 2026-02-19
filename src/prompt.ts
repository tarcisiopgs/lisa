import { resolve } from "node:path";
import type { Issue, MatutoConfig } from "./types.js";

export function buildImplementPrompt(issueId: string, config: MatutoConfig): string {
	const workspace = resolve(config.workspace);
	const repoEntries = config.repos
		.map((r) => `   - If it says "Repo: ${r.name}" or title starts with "${r.match}" → \`${resolve(workspace, r.path)}\``)
		.join("\n");

	const sourceInstructions = config.source === "trello"
		? `1. **Fetch the issue**: Use the Trello MCP tool to get full details of card \`${issueId}\`.`
		: `1. **Fetch the issue**: Use the Linear MCP tool to get full details of issue \`${issueId}\`.`;

	const updateInstructions = config.source === "trello"
		? `8. **Update Trello**: Move the card to "In Review" or "Done" list.
   Remove the "${config.source_config.label}" label.`
		: `8. **Update Linear**: Move the issue status to "In Review" or "In Progress" if "In Review" doesn't exist.
   Remove the "${config.source_config.label}" label.`;

	return `You are an autonomous implementation agent. Your job is to implement a single
issue and open a pull request.

## Instructions

${sourceInstructions}

2. **Identify the repo**: Look at the "Arquivos relevantes" section.
${repoEntries}
   - If it references multiple repos, pick the PRIMARY one (the one with the most files listed).

3. **Create a branch**: From the repo's main branch, create a branch named after the issue
   (e.g., \`feat/INT-129-connect-store-homepage\`). Use the git branch name from Linear if available.

4. **Implement**: Follow the issue description exactly:
   - Read all files listed in "Arquivos relevantes" first
   - Do what "O que fazer" says
   - Verify each item in "Critérios de aceite"
   - Respect "Stack / Restrições técnicas"

5. **Validate**: Run the project's linter/typecheck if available:
   - API: \`cd ${workspace}/api && bun run check\` (if script exists)
   - App/Admin: \`cd ${workspace}/{app|admin} && pnpm run lint && pnpm run typecheck\` (if scripts exist)
   - Store/Website: \`cd ${workspace}/{store|website} && pnpm run lint\` (if scripts exist)
   - Fix any errors before proceeding.

6. **Commit & Push**: Make atomic commits with conventional commit messages.
   Push the branch to origin.
   **IMPORTANT — Language rules:**
   - All commit messages MUST be in English.
   - Use conventional commits format: \`feat: ...\`, \`fix: ...\`, \`refactor: ...\`, \`chore: ...\`

7. **Open PR**: Use \`gh pr create\` with:
   - **Title MUST be in English**
   - **Body/description MUST be in English**
   - Reference the issue (e.g., "Closes ${issueId}")
   - Do NOT copy the issue title verbatim if it's in Portuguese — translate it to English.

${updateInstructions}

## Rules

- **ALL git commits, branch names, PR titles, and PR descriptions MUST be in English.**
- The issue description may be in Portuguese — read it for context but write all code artifacts in English.
- Do NOT modify files outside the target repo.
- Do NOT install new dependencies unless the issue explicitly requires it.
- If you get stuck or the issue is unclear, STOP and report why in the PR description.
- One issue only. Do not pick up additional issues.
- If the repo has a CLAUDE.md, read it first and follow its conventions.`;
}

export function buildLocalImplementPrompt(issue: Issue, config: MatutoConfig): string {
	const workspace = resolve(config.workspace);
	const repoEntries = config.repos
		.map((r) => `   - "${r.name}" → \`${resolve(workspace, r.path)}\``)
		.join("\n");

	const repoHint = issue.repo
		? `The issue specifies repo: **${issue.repo}**. Use that repo.`
		: `Determine the correct repo from the description or file references.`;

	return `You are an autonomous implementation agent. Your job is to implement a single
issue and open a pull request.

## Issue

**Title:** ${issue.title}
**ID:** ${issue.id}

**Description:**
${issue.description}

## Instructions

1. **Identify the repo**: ${repoHint}
   Available repos:
${repoEntries}

2. **Create a branch**: From the repo's main branch, create a branch named after the issue
   (e.g., \`feat/${issue.id}\`).

3. **Implement**: Follow the issue description exactly.

4. **Validate**: Run the project's linter/typecheck if available:
   - API: \`cd ${workspace}/api && bun run check\` (if script exists)
   - App/Admin: \`cd ${workspace}/{app|admin} && pnpm run lint && pnpm run typecheck\` (if scripts exist)
   - Store/Website: \`cd ${workspace}/{store|website} && pnpm run lint\` (if scripts exist)
   - Fix any errors before proceeding.

5. **Commit & Push**: Make atomic commits with conventional commit messages.
   Push the branch to origin.
   **IMPORTANT — Language rules:**
   - All commit messages MUST be in English.
   - Use conventional commits format: \`feat: ...\`, \`fix: ...\`, \`refactor: ...\`, \`chore: ...\`

6. **Open PR**: Use \`gh pr create\` with:
   - **Title MUST be in English**
   - **Body/description MUST be in English**
   - Do NOT copy the issue title verbatim if it's in Portuguese — translate it to English.

## Rules

- **ALL git commits, branch names, PR titles, and PR descriptions MUST be in English.**
- The issue description may be in Portuguese — read it for context but write all code artifacts in English.
- Do NOT modify files outside the target repo.
- Do NOT install new dependencies unless the issue explicitly requires it.
- If you get stuck or the issue is unclear, STOP and report why in the PR description.
- One issue only. Do not pick up additional issues.
- If the repo has a CLAUDE.md, read it first and follow its conventions.`;
}
