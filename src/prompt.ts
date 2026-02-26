import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { formatProjectContext, type ProjectContext } from "./context.js";
import { getManifestPath, getPlanPath } from "./paths.js";
import type { DependencyContext, Issue, LisaConfig, PlanStep } from "./types/index.js";

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

export function extractReadmeHeadings(cwd: string): string[] {
	const readmePath = join(cwd, "README.md");
	if (!existsSync(readmePath)) return [];

	try {
		const content = readFileSync(readmePath, "utf-8");
		return content
			.split("\n")
			.filter((line) => /^#{1,6}\s/.test(line))
			.map((line) => line.trim());
	} catch {
		return [];
	}
}

export function buildImplementPrompt(
	issue: Issue,
	config: LisaConfig,
	testRunner?: TestRunner,
	pm?: PackageManager,
	projectContext?: ProjectContext,
	cwd?: string,
	manifestPath?: string,
): string {
	const workspace = resolve(config.workspace);
	const resolvedManifestPath = manifestPath ?? getManifestPath(workspace);

	if (config.workflow === "worktree") {
		return buildWorktreePrompt(
			issue,
			testRunner,
			pm,
			config.base_branch,
			projectContext,
			resolvedManifestPath,
			cwd,
		);
	}

	return buildBranchPrompt(
		issue,
		config,
		testRunner,
		pm,
		projectContext,
		resolvedManifestPath,
		cwd,
	);
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

function buildReadmeInstructions(headings: string[]): string {
	if (headings.length === 0) return "";

	const headingList = headings.map((h) => `   - ${h}`).join("\n");

	return `
**README.md Validation:**
The current README.md documents these sections:
${headingList}

Review your implementation diff against these sections. Update README.md if your changes affect any documented behavior:
- CLI commands, flags, or usage examples
- Providers, sources, or integrations
- Configuration fields or schema
- Pipeline stages, workflow modes, or architecture
- Environment variables

Do NOT update README.md for internal refactors, bug fixes, test-only changes, logging, or dependency updates.

If an update is needed, modify only the affected sections. Keep the existing style and structure. Include the README change in the same commit.
`;
}

export function buildDependencyContext(dep: DependencyContext): string {
	const fileList =
		dep.changedFiles.length > 0
			? dep.changedFiles.map((f) => `  - \`${f}\``).join("\n")
			: "  (no files detected)";

	return `## Dependency Context

**This branch was created from the branch of issue ${dep.issueId}** (\`${dep.branch}\`), which has an open PR: ${dep.prUrl}

The following files were changed by the dependency and are already available in your working tree:
${fileList}

**Important:**
- Do NOT reimplement or modify code that was introduced by ${dep.issueId} — it already exists in your branch.
- Your PR must target \`${dep.branch}\` as its base branch (not \`main\`), so the diff only shows YOUR changes.
- When ${dep.issueId}'s PR is merged, your PR will be automatically re-targeted to \`main\`.
`;
}

function buildWorktreePrompt(
	issue: Issue,
	testRunner?: TestRunner,
	pm?: PackageManager,
	baseBranch?: string,
	projectContext?: ProjectContext,
	manifestPath?: string,
	cwd?: string,
): string {
	const testBlock = buildTestInstructions(testRunner ?? null, pm);
	const headings = cwd ? extractReadmeHeadings(cwd) : [];
	const readmeBlock = buildReadmeInstructions(headings);
	const hookBlock = buildPreCommitHookInstructions();
	const contextBlock = projectContext ? formatProjectContext(projectContext) : "";
	const depBlock = issue.dependency ? buildDependencyContext(issue.dependency) : "";
	const prBase = issue.dependency ? issue.dependency.branch : baseBranch;
	const manifestLocation = manifestPath
		? `\`${manifestPath}\``
		: "`.lisa-manifest.json` in the **current directory**";

	return `You are an autonomous implementation agent. Your job is to implement an issue end-to-end: code, push, PR, and tracker update.

You are already inside the correct repository worktree on the correct branch.
Do NOT create a new branch — just work on the current one.

## Issue

- **ID:** ${issue.id}
- **Title:** ${issue.title}
- **URL:** ${issue.url}

### Description

${issue.description}
${contextBlock ? `\n${contextBlock}\n` : ""}${depBlock ? `\n${depBlock}\n` : ""}
## Instructions

1. **Implement**: Follow the issue description exactly:
   - Read all relevant files listed in the description first (if present)
   - Follow the implementation instructions exactly
   - Verify each acceptance criteria (if present)
   - Respect any stack or technical constraints (if present)
${testBlock}${hookBlock}
2. **Validate**: Run the project's linter/typecheck/tests if available:
   - Check \`package.json\` (or equivalent) for lint, typecheck, check, or test scripts.
   - Run whichever validation scripts exist (e.g., \`npm run lint\`, \`npm run typecheck\`).
   - Fix any errors before proceeding.
${readmeBlock}
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
   \`gh pr create --title "<conventional-commit-title>" --body "<markdown-summary>"${prBase ? ` --base ${prBase}` : ""}\`
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

function buildBranchPrompt(
	issue: Issue,
	config: LisaConfig,
	testRunner?: TestRunner,
	pm?: PackageManager,
	projectContext?: ProjectContext,
	manifestPath?: string,
	cwd?: string,
): string {
	const workspace = resolve(config.workspace);
	const repoEntries = config.repos
		.map(
			(r) =>
				`   - If it says "Repo: ${r.name}" or title starts with "${r.match}" → \`${resolve(workspace, r.path)}\` (base branch: \`${r.base_branch}\`)`,
		)
		.join("\n");

	const baseBranch = config.base_branch;
	const prBase = issue.dependency ? issue.dependency.branch : baseBranch;

	const baseBranchInstruction = issue.dependency
		? `From \`${issue.dependency.branch}\` (dependency branch)`
		: config.repos.length > 0
			? "From the repo's base branch (listed above)"
			: `From \`${baseBranch}\``;

	const testBlock = buildTestInstructions(testRunner ?? null, pm);
	const headings = cwd ? extractReadmeHeadings(cwd) : [];
	const readmeBlock = buildReadmeInstructions(headings);
	const hookBlock = buildPreCommitHookInstructions();
	const contextBlock = projectContext ? formatProjectContext(projectContext) : "";
	const depBlock = issue.dependency ? buildDependencyContext(issue.dependency) : "";
	const resolvedManifestPath = manifestPath ?? getManifestPath(workspace);

	return `You are an autonomous implementation agent. Your job is to implement an issue end-to-end: code, push, PR, and tracker update.

## Issue

- **ID:** ${issue.id}
- **Title:** ${issue.title}
- **URL:** ${issue.url}

### Description

${issue.description}
${contextBlock ? `\n${contextBlock}\n` : ""}${depBlock ? `\n${depBlock}\n` : ""}
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
${testBlock}${hookBlock}
4. **Validate**: Run the project's linter/typecheck/tests if available:
   - Check \`package.json\` (or equivalent) for lint, typecheck, check, or test scripts.
   - Run whichever validation scripts exist (e.g., \`npm run lint\`, \`npm run typecheck\`).
   - Fix any errors before proceeding.
${readmeBlock}
5. **Commit & Push**: Make atomic commits with conventional commit messages.
   Push the branch to origin:
   \`git push -u origin <branch-name>\`
   If the push fails due to a pre-push hook, read the error, fix the root cause, amend the commit, and retry. Do NOT use \`--no-verify\`.
   **IMPORTANT — Language rules:**
   - All commit messages MUST be in English.
   - Use conventional commits format: \`feat: ...\`, \`fix: ...\`, \`refactor: ...\`, \`chore: ...\`

6. **Create PR**: Create a pull request using the GitHub CLI:
   \`gh pr create --title "<conventional-commit-title>" --body "<markdown-summary>" --base ${prBase}\`
   Capture the PR URL from the output.

7. **Update tracker**: Call the lisa CLI to mark the issue as done:
   \`lisa issue done ${issue.id} --pr-url <pr-url>\`
   Wait 1 second before calling this command.

8. **Write manifest**: Before finishing, create \`${resolvedManifestPath}\` with JSON:
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
	manifestPath?: string,
): string {
	const testBlock = buildTestInstructions(testRunner ?? null, pm);
	const headings = repoPath ? extractReadmeHeadings(repoPath) : [];
	const readmeBlock = buildReadmeInstructions(headings);
	const hookBlock = buildPreCommitHookInstructions();
	const contextBlock = projectContext ? formatProjectContext(projectContext) : "";
	const depBlock = issue.dependency ? buildDependencyContext(issue.dependency) : "";
	const prBase = issue.dependency ? issue.dependency.branch : baseBranch;
	const manifestLocation = manifestPath
		? `\`${manifestPath}\``
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
${contextBlock ? `\n${contextBlock}\n` : ""}${depBlock ? `\n${depBlock}\n` : ""}
## Instructions

1. **Implement**: Follow the issue description exactly:
   - Read all relevant files listed in the description first (if present)
   - Follow the implementation instructions exactly
   - Verify each acceptance criteria (if present)
   - Respect any stack or technical constraints (if present)
${testBlock}${hookBlock}
2. **Validate**: Run the project's linter/typecheck/tests if available:
   - Check \`package.json\` (or equivalent) for lint, typecheck, check, or test scripts.
   - Run whichever validation scripts exist (e.g., \`npm run lint\`, \`npm run typecheck\`).
   - Fix any errors before proceeding.
${readmeBlock}
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
   \`gh pr create --title "<conventional-commit-title>" --body "<markdown-summary>"${prBase ? ` --base ${prBase}` : ""}\`
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

export function buildPlanningPrompt(issue: Issue, config: LisaConfig, planPath?: string): string {
	const workspace = resolve(config.workspace);

	const repoBlock = config.repos
		.map((r) => {
			const absPath = resolve(workspace, r.path);
			return `- **${r.name}**: \`${absPath}\` (base branch: \`${r.base_branch}\`)`;
		})
		.join("\n");

	const resolvedPlanPath = planPath ?? getPlanPath(workspace);

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

3. **Write the plan**: Create \`${resolvedPlanPath}\` with JSON:
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
	manifestPath?: string,
	cwd?: string,
): string {
	const testBlock = buildTestInstructions(testRunner ?? null, pm);
	const headings = cwd ? extractReadmeHeadings(cwd) : [];
	const readmeBlock = buildReadmeInstructions(headings);
	const hookBlock = buildPreCommitHookInstructions();
	const contextBlock = projectContext ? formatProjectContext(projectContext) : "";
	const depBlock = issue.dependency ? buildDependencyContext(issue.dependency) : "";
	const prBase = issue.dependency ? issue.dependency.branch : baseBranch;

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
${contextBlock ? `\n${contextBlock}\n` : ""}${depBlock ? `\n${depBlock}\n` : ""}
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
${testBlock}${hookBlock}
2. **Validate**: Run the project's linter/typecheck/tests if available:
   - Check \`package.json\` (or equivalent) for lint, typecheck, check, or test scripts.
   - Run whichever validation scripts exist (e.g., \`npm run lint\`, \`npm run typecheck\`).
   - Fix any errors before proceeding.
${readmeBlock}
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
   \`gh pr create --title "<conventional-commit-title>" --body "<markdown-summary>"${prBase ? ` --base ${prBase}` : ""}\`
   Capture the PR URL from the output.
${trackerStep}
7. **Write manifest**: Create ${manifestPath ? `\`${manifestPath}\`` : "`.lisa-manifest.json` in the **current directory**"} with JSON:
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
