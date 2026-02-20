import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Issue, LisaConfig } from "./types.js";

export type TestRunner = "vitest" | "jest" | null;

export function detectTestRunner(cwd: string): TestRunner {
	const packageJsonPath = join(cwd, "package.json");
	if (!existsSync(packageJsonPath)) return null;

	try {
		const content = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
			devDependencies?: Record<string, string>;
			dependencies?: Record<string, string>;
		};
		const deps = { ...content.dependencies, ...content.devDependencies };
		if ("vitest" in deps) return "vitest";
		if ("jest" in deps) return "jest";
		return null;
	} catch {
		return null;
	}
}

export function buildImplementPrompt(
	issue: Issue,
	config: LisaConfig,
	testRunner?: TestRunner,
): string {
	if (config.workflow === "worktree") {
		return buildWorktreePrompt(issue, testRunner);
	}

	return buildBranchPrompt(issue, config, testRunner);
}

function buildTestInstructions(testRunner: TestRunner): string {
	if (!testRunner) return "";

	return `
**MANDATORY — Unit Tests:**
This project uses **${testRunner}** as its test runner.
- You MUST write unit tests (\`*.test.ts\`) for every new file or module you create.
- Tests should cover the main functionality, edge cases, and error scenarios.
- Run \`npm run test\` and ensure ALL tests pass before committing.
- Do NOT skip writing tests — the PR will be blocked if tests are missing or failing.
`;
}

function buildWorktreePrompt(issue: Issue, testRunner?: TestRunner): string {
	const testBlock = buildTestInstructions(testRunner ?? null);

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
${testBlock}
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

function buildBranchPrompt(issue: Issue, config: LisaConfig, testRunner?: TestRunner): string {
	const workspace = resolve(config.workspace);
	const repoEntries = config.repos
		.map(
			(r) =>
				`   - If it says "Repo: ${r.name}" or title starts with "${r.match}" → \`${resolve(workspace, r.path)}\` (base branch: \`${r.base_branch}\`)`,
		)
		.join("\n");

	const baseBranchInstruction =
		config.repos.length > 0
			? "From the repo's base branch (listed above)"
			: `From \`${config.base_branch}\``;

	const testBlock = buildTestInstructions(testRunner ?? null);

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

2. **Create a branch**: ${baseBranchInstruction}, create a branch named after the issue
   (e.g., \`feat/${issue.id.toLowerCase()}-short-description\`).

3. **Implement**: Follow the issue description exactly:
   - Read all relevant files listed in the description first (if present)
   - Follow the implementation instructions exactly
   - Verify each acceptance criteria (if present)
   - Respect any stack or technical constraints (if present)
${testBlock}
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
