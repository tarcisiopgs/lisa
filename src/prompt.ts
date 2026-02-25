import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { formatProjectContext, type ProjectContext } from "./context.js";
import type { Issue, LisaConfig, PlanStep } from "./types/index.js";

export type TestRunner = "vitest" | "jest" | null;
export type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

export function detectPackageManager(cwd: string): PackageManager {
	if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock"))) return "bun";
	if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
	if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
	return "npm";
}

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
	pm?: PackageManager,
	projectContext?: ProjectContext,
): string {
	if (config.workflow === "worktree") {
		return buildWorktreePrompt(issue, testRunner, pm, config.base_branch, projectContext);
	}

	return buildBranchPrompt(issue, config, testRunner, pm, projectContext);
}

function buildTestInstructions(testRunner: TestRunner, pm: PackageManager = "npm"): string {
	if (!testRunner) return "";

	const testCmd = pm === "bun" ? "bun run test" : `${pm} run test`;

	return `
**MANDATORY — Unit Tests:**
This project uses **${testRunner}** as its test runner.
- You MUST write unit tests (\`*.test.ts\`) for every new file or module you create.
- Tests should cover the main functionality, edge cases, and error scenarios.
- Run \`${testCmd}\` and ensure ALL tests pass before committing.
- Do NOT skip writing tests — the PR will be blocked if tests are missing or failing.
`;
}

function buildPreCommitHookInstructions(): string {
	return `
**Pre-commit hooks:**
If \`git commit\` fails due to a pre-commit hook (e.g. husky), read the error output carefully and fix the underlying issue:
- Linter/formatter failures → run the project's lint/format commands, then re-stage and retry the commit.
- Code generation errors (e.g. stale Prisma client) → run the required generation command (e.g. \`npx prisma generate\`), then re-stage and retry.
- Type errors → fix the type issues in the source files, then re-stage and retry.
Do NOT skip or bypass hooks (no \`--no-verify\`). Fix the root cause and retry.
`;
}

function buildReadmeInstructions(): string {
	return `
**README.md Evaluation:**
After implementing, review the diff of all changed files and check if README.md needs updating.

Update README.md if the changes include:
- New or removed CLI commands or flags
- New or removed providers or sources
- Configuration schema changes (new fields, renamed fields, removed fields)
- Pipeline or workflow stage changes
- New or removed environment variables
- Architectural changes

Do NOT update README.md for:
- Internal refactors that don't change documented behavior
- Bug fixes that don't change documented behavior
- Test-only changes
- Logging or formatting changes
- Dependency updates

If an update is needed, keep the existing README style and structure. Include the README change in the same commit as the implementation.
`;
}

function buildWorktreePrompt(
	issue: Issue,
	testRunner?: TestRunner,
	pm?: PackageManager,
	baseBranch?: string,
	projectContext?: ProjectContext,
): string {
	const testBlock = buildTestInstructions(testRunner ?? null, pm);
	const readmeBlock = buildReadmeInstructions();
	const hookBlock = buildPreCommitHookInstructions();
	const contextBlock = projectContext ? formatProjectContext(projectContext) : "";

	return `You are an autonomous implementation agent. Your job is to implement an issue end-to-end: code, push, PR, and tracker update.

You are already inside the correct repository worktree on the correct branch.
Do NOT create a new branch — just work on the current one.

## Issue

- **ID:** ${issue.id}
- **Title:** ${issue.title}
- **URL:** ${issue.url}

### Description

${issue.description}
${contextBlock ? `\n${contextBlock}\n` : ""}

## Instructions

1. **Implement**: Follow the issue description exactly:
   - Read all relevant files listed in the description first (if present)
   - Follow the implementation instructions exactly
   - Verify each acceptance criteria (if present)
   - Respect any stack or technical constraints (if present)
${testBlock}${readmeBlock}${hookBlock}
2. **Validate**: Run the project's linter/typecheck/tests if available:
   - Check \`package.json\` (or equivalent) for lint, typecheck, check, or test scripts.
   - Run whichever validation scripts exist (e.g., \`npm run lint\`, \`npm run typecheck\`).
   - Fix any errors before proceeding.

3. **Commit**: Make atomic commits with conventional commit messages.
   **Branch name must be in English.** If the current branch name contains non-English words,
   rename it before committing using the single-argument form:
   \`git branch -m feat/${issue.id.toLowerCase()}-short-english-slug\`
   **IMPORTANT — Language rules:**
   - All commit messages MUST be in English.
   - Use conventional commits format: \`feat: ...\`, \`fix: ...\`, \`refactor: ...\`, \`chore: ...\`

4. **Push**: Push the branch to origin:
   \`git push -u origin <branch-name>\`
   If the push fails due to a pre-push hook, read the error, fix the root cause, amend the commit, and retry. Do NOT use \`--no-verify\`.

5. **Create PR**: Create a pull request using the GitHub CLI:
   \`gh pr create --title "<conventional-commit-title>" --body "<markdown-summary>"${baseBranch ? ` --base ${baseBranch}` : ""}\`
   Capture the PR URL from the output.

6. **Update tracker**: Call the lisa CLI to mark the issue as done:
   \`lisa issue done ${issue.id} --pr-url <pr-url>\`
   Wait 1 second before calling this command.

7. **Write manifest**: Create \`.lisa-manifest.json\` in the **current directory** with JSON:
   \`\`\`json
   {"branch": "<final English branch name>", "prUrl": "<pull request URL>"}
   \`\`\`
   Do NOT commit this file.

## Rules

- **ALL git commits, branch names, PR titles, and PR descriptions MUST be in English.**
- The issue description may be in any language — read it for context but write all code artifacts in English.
- Do NOT install new dependencies unless the issue explicitly requires it.
- If you get stuck or the issue is unclear, STOP and explain why.
- One issue only. Do not pick up additional issues.
- If the repo has a CLAUDE.md, read it first and follow its conventions.`;
}

function buildBranchPrompt(
	issue: Issue,
	config: LisaConfig,
	testRunner?: TestRunner,
	pm?: PackageManager,
	projectContext?: ProjectContext,
): string {
	const workspace = resolve(config.workspace);
	const repoEntries = config.repos
		.map(
			(r) =>
				`   - If it says "Repo: ${r.name}" or title starts with "${r.match}" → \`${resolve(workspace, r.path)}\` (base branch: \`${r.base_branch}\`)`,
		)
		.join("\n");

	const baseBranch = config.base_branch;

	const baseBranchInstruction =
		config.repos.length > 0
			? "From the repo's base branch (listed above)"
			: `From \`${baseBranch}\``;

	const testBlock = buildTestInstructions(testRunner ?? null, pm);
	const readmeBlock = buildReadmeInstructions();
	const hookBlock = buildPreCommitHookInstructions();
	const contextBlock = projectContext ? formatProjectContext(projectContext) : "";
	const manifestPath = join(workspace, ".lisa-manifest.json");

	return `You are an autonomous implementation agent. Your job is to implement an issue end-to-end: code, push, PR, and tracker update.

## Issue

- **ID:** ${issue.id}
- **Title:** ${issue.title}
- **URL:** ${issue.url}

### Description

${issue.description}
${contextBlock ? `\n${contextBlock}\n` : ""}
## Instructions

1. **Identify the repo**: Look at the issue description for relevant files or repo references.
${repoEntries}
   - If it references multiple repos, pick the PRIMARY one (the one with the most files listed).

2. **Create a branch**: ${baseBranchInstruction}, create a branch with an **English** slug:
   \`feat/${issue.id.toLowerCase()}-short-english-description\`
   The description MUST be in English — translate or summarize the issue title if it's in another language.
   Example: "Implementar rate limiting na API" → \`feat/${issue.id.toLowerCase()}-add-rate-limiting-to-api\`

3. **Implement**: Follow the issue description exactly:
   - Read all relevant files listed in the description first (if present)
   - Follow the implementation instructions exactly
   - Verify each acceptance criteria (if present)
   - Respect any stack or technical constraints (if present)
${testBlock}${readmeBlock}${hookBlock}
4. **Validate**: Run the project's linter/typecheck/tests if available:
   - Check \`package.json\` (or equivalent) for lint, typecheck, check, or test scripts.
   - Run whichever validation scripts exist (e.g., \`npm run lint\`, \`npm run typecheck\`).
   - Fix any errors before proceeding.

5. **Commit & Push**: Make atomic commits with conventional commit messages.
   Push the branch to origin:
   \`git push -u origin <branch-name>\`
   If the push fails due to a pre-push hook, read the error, fix the root cause, amend the commit, and retry. Do NOT use \`--no-verify\`.
   **IMPORTANT — Language rules:**
   - All commit messages MUST be in English.
   - Use conventional commits format: \`feat: ...\`, \`fix: ...\`, \`refactor: ...\`, \`chore: ...\`

6. **Create PR**: Create a pull request using the GitHub CLI:
   \`gh pr create --title "<conventional-commit-title>" --body "<markdown-summary>" --base ${baseBranch}\`
   Capture the PR URL from the output.

7. **Update tracker**: Call the lisa CLI to mark the issue as done:
   \`lisa issue done ${issue.id} --pr-url <pr-url>\`
   Wait 1 second before calling this command.

8. **Write manifest**: Before finishing, create \`${manifestPath}\` with JSON:
   \`\`\`json
   {"repoPath": "<absolute path to this repo>", "branch": "<branch name>", "prUrl": "<pull request URL>"}
   \`\`\`
   Do NOT commit this file.

## Rules

- **ALL git commits, branch names, PR titles, and PR descriptions MUST be in English.**
- The issue description may be in any language — read it for context but write all code artifacts in English.
- Do NOT modify files outside the target repo.
- Do NOT install new dependencies unless the issue explicitly requires it.
- If you get stuck or the issue is unclear, STOP and explain why.
- One issue only. Do not pick up additional issues.
- If the repo has a CLAUDE.md, read it first and follow its conventions.`;
}

export function buildNativeWorktreePrompt(
	issue: Issue,
	repoPath?: string,
	testRunner?: TestRunner,
	pm?: PackageManager,
	baseBranch?: string,
	projectContext?: ProjectContext,
): string {
	const testBlock = buildTestInstructions(testRunner ?? null, pm);
	const readmeBlock = buildReadmeInstructions();
	const hookBlock = buildPreCommitHookInstructions();
	const contextBlock = projectContext ? formatProjectContext(projectContext) : "";
	const manifestLocation = repoPath
		? `\`${join(repoPath, ".lisa-manifest.json")}\``
		: "`.lisa-manifest.json` in the **current directory**";

	return `You are an autonomous implementation agent. Your job is to implement an issue end-to-end: code, push, PR, and tracker update.

You are working inside a git worktree that was automatically created for this task.
Work on the current branch — it was created for you.

## Issue

- **ID:** ${issue.id}
- **Title:** ${issue.title}
- **URL:** ${issue.url}

### Description

${issue.description}
${contextBlock ? `\n${contextBlock}\n` : ""}

## Instructions

1. **Implement**: Follow the issue description exactly:
   - Read all relevant files listed in the description first (if present)
   - Follow the implementation instructions exactly
   - Verify each acceptance criteria (if present)
   - Respect any stack or technical constraints (if present)
${testBlock}${readmeBlock}${hookBlock}
2. **Validate**: Run the project's linter/typecheck/tests if available:
   - Check \`package.json\` (or equivalent) for lint, typecheck, check, or test scripts.
   - Run whichever validation scripts exist (e.g., \`npm run lint\`, \`npm run typecheck\`).
   - Fix any errors before proceeding.

3. **Commit**: Make atomic commits with conventional commit messages.
   **Branch name must be in English.** If the current branch name contains non-English words,
   rename it: \`git branch -m <current-name> feat/${issue.id.toLowerCase()}-short-english-slug\`
   **IMPORTANT — Language rules:**
   - All commit messages MUST be in English.
   - Use conventional commits format: \`feat: ...\`, \`fix: ...\`, \`refactor: ...\`, \`chore: ...\`

4. **Push**: Push the branch to origin:
   \`git push -u origin <branch-name>\`
   If the push fails due to a pre-push hook, read the error, fix the root cause, amend the commit, and retry. Do NOT use \`--no-verify\`.

5. **Create PR**: Create a pull request using the GitHub CLI:
   \`gh pr create --title "<conventional-commit-title>" --body "<markdown-summary>"${baseBranch ? ` --base ${baseBranch}` : ""}\`
   Capture the PR URL from the output.

6. **Update tracker**: Call the lisa CLI to mark the issue as done:
   \`lisa issue done ${issue.id} --pr-url <pr-url>\`
   Wait 1 second before calling this command.

7. **Write manifest**: Create ${manifestLocation} with JSON:
   \`\`\`json
   {"branch": "<final English branch name>", "prUrl": "<pull request URL>"}
   \`\`\`
   Do NOT commit this file.

## Rules

- **ALL git commits, branch names, PR titles, and PR descriptions MUST be in English.**
- The issue description may be in any language — read it for context but write all code artifacts in English.
- Do NOT install new dependencies unless the issue explicitly requires it.
- If you get stuck or the issue is unclear, STOP and explain why.
- One issue only. Do not pick up additional issues.
- If the repo has a CLAUDE.md, read it first and follow its conventions.`;
}

export function buildPlanningPrompt(issue: Issue, config: LisaConfig): string {
	const workspace = resolve(config.workspace);

	const repoBlock = config.repos
		.map((r) => {
			const absPath = resolve(workspace, r.path);
			return `- **${r.name}**: \`${absPath}\` (base branch: \`${r.base_branch}\`)`;
		})
		.join("\n");

	const planPath = join(workspace, ".lisa-plan.json");

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

## Instructions

1. **Analyze the issue**: Read the title and description carefully. Determine which repositories above are affected by this change.
   Consider:
   - File paths or module names mentioned in the description
   - Technologies and frameworks referenced
   - Dependencies between repos (e.g., backend API changes needed before frontend can consume them)

2. **Determine execution order**: If multiple repos are affected, decide the order. Repos that produce APIs, schemas, or shared libraries should come first. Repos that consume them should come later.

3. **Write the plan**: Create \`${planPath}\` with JSON:
   \`\`\`json
   {
     "steps": [
       { "repoPath": "<absolute path to repo>", "scope": "<what to implement in this repo>", "order": 1 },
       { "repoPath": "<absolute path to repo>", "scope": "<what to implement in this repo>", "order": 2 }
     ]
   }
   \`\`\`

## Rules

- Only include repos that are actually affected by the issue. Do NOT include repos that don't need changes.
- The \`scope\` field should be a concise English description of what needs to be done in that specific repo.
- Order matters: lower order numbers execute first.
- Do NOT implement anything. Do NOT create branches, write code, or commit.
- If only one repo is affected, the plan should have a single step.`;
}

export interface PreviousStepResult {
	repoPath: string;
	branch: string;
	prUrl?: string;
}

export function buildScopedImplementPrompt(
	issue: Issue,
	step: PlanStep,
	previousResults: PreviousStepResult[],
	testRunner?: TestRunner,
	pm?: PackageManager,
	isLastStep = false,
	baseBranch?: string,
	projectContext?: ProjectContext,
): string {
	const testBlock = buildTestInstructions(testRunner ?? null, pm);
	const readmeBlock = buildReadmeInstructions();
	const hookBlock = buildPreCommitHookInstructions();
	const contextBlock = projectContext ? formatProjectContext(projectContext) : "";

	const previousBlock =
		previousResults.length > 0
			? `\n## Previous Steps\n\nThe following repos have already been implemented as part of this issue:\n\n${previousResults.map((r) => `- **${r.repoPath}**: branch \`${r.branch}\`${r.prUrl ? ` — PR: ${r.prUrl}` : ""}`).join("\n")}\n\nUse this context if the current step depends on changes from previous steps.\n`
			: "";

	const trackerStep = isLastStep
		? `\n6. **Update tracker**: Call \`lisa issue done ${issue.id} --pr-url <pr-url>\` (wait 1 second before calling).\n`
		: `\n6. **Skip tracker update**: This is not the last step. The caller handles the tracker update after all steps complete.\n`;

	return `You are an autonomous implementation agent. Your job is to implement a specific part of an issue in a single repository.

You are working inside a git worktree that was automatically created for this task.
Work on the current branch — it was created for you.

## Issue

- **ID:** ${issue.id}
- **Title:** ${issue.title}
- **URL:** ${issue.url}

### Description

${issue.description}
${contextBlock ? `\n${contextBlock}\n` : ""}
## Your Scope

You are responsible for **this specific part** of the issue:

> ${step.scope}

Focus only on this scope. Do NOT implement changes outside this scope.
${previousBlock}
## Instructions

1. **Implement**: Follow the scope above. Read the full issue description for context, but only implement what is described in "Your Scope":
   - Read all relevant files first
   - Follow the implementation instructions exactly
   - Verify each acceptance criteria relevant to your scope
${testBlock}${readmeBlock}${hookBlock}
2. **Validate**: Run the project's linter/typecheck/tests if available:
   - Check \`package.json\` (or equivalent) for lint, typecheck, check, or test scripts.
   - Run whichever validation scripts exist (e.g., \`npm run lint\`, \`npm run typecheck\`).
   - Fix any errors before proceeding.

3. **Commit**: Make atomic commits with conventional commit messages.
   **Branch name must be in English.** If the current branch name contains non-English words,
   rename it: \`git branch -m <current-name> feat/${issue.id.toLowerCase()}-short-english-slug\`
   **IMPORTANT — Language rules:**
   - All commit messages MUST be in English.
   - Use conventional commits format: \`feat: ...\`, \`fix: ...\`, \`refactor: ...\`, \`chore: ...\`

4. **Push**: Push the branch to origin:
   \`git push -u origin <branch-name>\`
   If the push fails due to a pre-push hook, read the error, fix the root cause, amend the commit, and retry. Do NOT use \`--no-verify\`.

5. **Create PR**: Create a pull request using the GitHub CLI:
   \`gh pr create --title "<conventional-commit-title>" --body "<markdown-summary>"${baseBranch ? ` --base ${baseBranch}` : ""}\`
   Capture the PR URL from the output.
${trackerStep}
7. **Write manifest**: Create \`.lisa-manifest.json\` in the **current directory** with JSON:
   \`\`\`json
   {"branch": "<final English branch name>", "prUrl": "<pull request URL>"}
   \`\`\`
   Do NOT commit this file.

## Rules

- **ALL git commits, branch names, PR titles, and PR descriptions MUST be in English.**
- The issue description may be in any language — read it for context but write all code artifacts in English.
- Do NOT install new dependencies unless the issue explicitly requires it.
- If you get stuck or the issue is unclear, STOP and explain why.
- One scope only. Do not pick up additional work outside your scope.
- If the repo has a CLAUDE.md, read it first and follow its conventions.`;
}
