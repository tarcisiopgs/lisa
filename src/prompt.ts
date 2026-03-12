import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { formatProjectContext, type ProjectContext, type ProjectEnvironment } from "./context.js";
import { buildPrCreateInstruction } from "./git/platform.js";
import { getManifestPath, getPlanPath } from "./paths.js";
import type { DependencyContext, Issue, LisaConfig, PlanStep, PRPlatform } from "./types/index.js";

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
	repoContextMd?: string | null,
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
			config.platform,
			repoContextMd,
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
		repoContextMd,
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

function buildSpecWarningBlock(warning?: string): string {
	if (!warning) return "";
	return `\n> **Warning — incomplete spec:** ${warning}\n> Proceed using reasonable assumptions based on the title and description.\n> If the issue is genuinely too ambiguous to implement, STOP and explain what is missing.\n`;
}

function buildRulesSection(
	env?: ProjectEnvironment,
	variant: "issue" | "scope" = "issue",
	extraRules = "",
): string {
	const envRule = buildEnvironmentDependencyRule(env);
	const scopeRule =
		variant === "scope"
			? "- One scope only. Do not pick up additional work outside your scope."
			: "- One issue only. Do not pick up additional issues.";

	return `## Rules

- **ALL git commits, branch names, PR titles, and PR descriptions MUST be in English.**
- The issue description may be in any language — read it for context but write all code artifacts in English.
- Do NOT install new dependencies unless the issue explicitly requires it.
- Do NOT use documentation lookup MCP tools (e.g., Context7, codesearch, Exa) — they have free-tier rate limits that will block your execution. Read files directly from the repository. Web search is allowed only when strictly necessary (e.g., looking up an external API format not available in the codebase).
${envRule}${extraRules}- If you get stuck or the issue is unclear, STOP and explain why.
${scopeRule}
- If the repo has a CLAUDE.md, read it first and follow its conventions.`;
}

function buildEnvironmentDependencyRule(env?: ProjectEnvironment): string {
	if (env === "cli") {
		return "- **Environment**: This is a CLI (Node.js) project. Do NOT install browser/DOM packages (`jsdom`, `happy-dom`, `@testing-library/dom`, `@testing-library/react`). All dependencies and tests must be Node.js-compatible.\n";
	}
	if (env === "mobile") {
		return "- **Environment**: This is a mobile project (React Native/Flutter). Do NOT install browser/DOM packages or web-only libraries. Use only packages compatible with the mobile runtime.\n";
	}
	if (env === "server") {
		return "- **Environment**: This is a server-side (Node.js) project. Do NOT install browser/DOM packages. Use only Node.js-compatible packages.\n";
	}
	return "";
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

export function buildContextMdBlock(content: string | null | undefined): string {
	if (!content?.trim()) return "";
	return `\n## Project Conventions\n\n${content.trim()}\n`;
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
	platform: PRPlatform = "cli",
	repoContextMd?: string | null,
): string {
	const testBlock = buildTestInstructions(testRunner ?? null, pm);
	const apiClientBlock = "";
	const headings = cwd ? extractReadmeHeadings(cwd) : [];
	const readmeBlock = buildReadmeInstructions(headings);
	const hookBlock = buildPreCommitHookInstructions();
	const contextBlock = projectContext ? formatProjectContext(projectContext) : "";
	const depBlock = issue.dependency ? buildDependencyContext(issue.dependency) : "";
	const specWarningBlock = buildSpecWarningBlock(issue.specWarning);
	const contextMdBlock = buildContextMdBlock(repoContextMd ?? null);
	const prBase = issue.dependency ? issue.dependency.branch : baseBranch;
	const manifestLocation = manifestPath
		? `\`${manifestPath}\``
		: "`.lisa/manifests/default.json` in the **current directory**";
	const prCreateBlock = buildPrCreateInstruction(platform, prBase);

	return `You are an autonomous implementation agent. You MUST complete ALL steps below — implementation, commit, push, PR creation, and manifest file — before finishing.
Do NOT stop after implementing code. The task is NOT complete until the manifest file is written with the PR URL.
Do NOT use interactive skills, ask clarifying questions, or wait for user input. You are running unattended. No human will see your output or respond to questions. If the issue is too ambiguous to implement, you MUST STOP and provide a clear explanation.

You are already inside the correct repository worktree on the correct branch.
Do NOT create a new branch — just work on the current one.
${cwd ? `\n**Working directory:** \`${cwd}\`\nAll file paths are relative to this directory. Use this as the base for any absolute paths.\n` : ""}
## Issue

- **ID:** ${issue.id}
- **Title:** ${issue.title}
- **URL:** ${issue.url}

### Description

${issue.description}
${specWarningBlock}${contextBlock ? `\n${contextBlock}\n` : ""}${contextMdBlock}${depBlock ? `\n${depBlock}\n` : ""}
## Instructions

1. **Implement**: Follow the issue description exactly:
   - Read all relevant files listed in the description first (if present)
   - Follow the implementation instructions exactly
   - Verify each acceptance criteria (if present)
   - Respect any stack or technical constraints (if present)
${testBlock}${apiClientBlock}${hookBlock}
2. **Validate**: Run the project's linter/typecheck/tests if available:
   - Check \`package.json\` (or equivalent) for lint, typecheck, check, or test scripts.
   - Run whichever validation scripts exist (e.g., \`npm run lint\`, \`npm run typecheck\`).
   - Fix any errors before proceeding.
${readmeBlock}
**CRITICAL — Do NOT stop here. The following steps (commit, push, PR, manifest) are MANDATORY. Skipping them means the task has FAILED.**

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

5. ${prCreateBlock}

6. **Update tracker**: Call the lisa CLI to mark the issue as done:
   \`lisa issue done ${issue.id} --pr-url <pr-url>\`
   Wait 1 second before calling this command.

7. **Write manifest**: Create ${manifestLocation} with JSON:
   \`\`\`json
   {"branch": "<final English branch name>", "prUrl": "<pull request URL>"}
   \`\`\`
   Do NOT commit this file.

${buildRulesSection(projectContext?.environment)}

## Completion Checklist

Before finishing, verify ALL of the following are true:
- [ ] Code changes are committed (no uncommitted changes)
- [ ] Branch is pushed to origin
- [ ] Pull request is created and URL is captured
- [ ] Manifest file is written with \`prUrl\` field
If ANY item is unchecked, go back and complete it. Do NOT finish with incomplete steps.`;
}

function buildBranchPrompt(
	issue: Issue,
	config: LisaConfig,
	testRunner?: TestRunner,
	pm?: PackageManager,
	projectContext?: ProjectContext,
	manifestPath?: string,
	cwd?: string,
	repoContextMd?: string | null,
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
	const apiClientBlock = "";
	const headings = cwd ? extractReadmeHeadings(cwd) : [];
	const readmeBlock = buildReadmeInstructions(headings);
	const hookBlock = buildPreCommitHookInstructions();
	const contextBlock = projectContext ? formatProjectContext(projectContext) : "";
	const depBlock = issue.dependency ? buildDependencyContext(issue.dependency) : "";
	const specWarningBlock = buildSpecWarningBlock(issue.specWarning);
	const contextMdBlock = buildContextMdBlock(repoContextMd ?? null);
	const resolvedManifestPath = manifestPath ?? getManifestPath(workspace);

	return `You are an autonomous implementation agent. You MUST complete ALL steps below — implementation, commit, push, PR creation, and manifest file — before finishing.
Do NOT stop after implementing code. The task is NOT complete until the manifest file is written with the PR URL.
Do NOT use interactive skills, ask clarifying questions, or wait for user input. You are running unattended. No human will see your output or respond to questions. If the issue is too ambiguous to implement, you MUST STOP and provide a clear explanation.

## Issue

- **ID:** ${issue.id}
- **Title:** ${issue.title}
- **URL:** ${issue.url}

### Description

${issue.description}
${specWarningBlock}${contextBlock ? `\n${contextBlock}\n` : ""}${contextMdBlock}${depBlock ? `\n${depBlock}\n` : ""}
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
${testBlock}${apiClientBlock}${hookBlock}
4. **Validate**: Run the project's linter/typecheck/tests if available:
   - Check \`package.json\` (or equivalent) for lint, typecheck, check, or test scripts.
   - Run whichever validation scripts exist (e.g., \`npm run lint\`, \`npm run typecheck\`).
   - Fix any errors before proceeding.
${readmeBlock}
**CRITICAL — Do NOT stop here. The following steps (commit, push, PR, manifest) are MANDATORY. Skipping them means the task has FAILED.**

5. **Commit & Push**: Make atomic commits with conventional commit messages.
   Push the branch to origin:
   \`git push -u origin <branch-name>\`
   If the push fails due to a pre-push hook, read the error, fix the root cause, amend the commit, and retry. Do NOT use \`--no-verify\`.
   **IMPORTANT — Language rules:**
   - All commit messages MUST be in English.
   - Use conventional commits format: \`feat: ...\`, \`fix: ...\`, \`refactor: ...\`, \`chore: ...\`

6. ${buildPrCreateInstruction(config.platform, prBase)}

7. **Update tracker**: Call the lisa CLI to mark the issue as done:
   \`lisa issue done ${issue.id} --pr-url <pr-url>\`
   Wait 1 second before calling this command.

8. **Write manifest**: Before finishing, create \`${resolvedManifestPath}\` with JSON:
   \`\`\`json
   {"repoPath": "<absolute path to this repo>", "branch": "<branch name>", "prUrl": "<pull request URL>"}
   \`\`\`
   Do NOT commit this file.

${buildRulesSection(projectContext?.environment, "issue", "- Do NOT modify files outside the target repo.\n")}

## Completion Checklist

Before finishing, verify ALL of the following are true:
- [ ] Code changes are committed (no uncommitted changes)
- [ ] Branch is pushed to origin
- [ ] Pull request is created and URL is captured
- [ ] Manifest file is written with \`prUrl\` field
If ANY item is unchecked, go back and complete it. Do NOT finish with incomplete steps.`;
}

export function buildNativeWorktreePrompt(
	issue: Issue,
	repoPath?: string,
	testRunner?: TestRunner,
	pm?: PackageManager,
	baseBranch?: string,
	projectContext?: ProjectContext,
	manifestPath?: string,
	platform: PRPlatform = "cli",
	repoContextMd?: string | null,
): string {
	const testBlock = buildTestInstructions(testRunner ?? null, pm);
	const apiClientBlock = "";
	const headings = repoPath ? extractReadmeHeadings(repoPath) : [];
	const readmeBlock = buildReadmeInstructions(headings);
	const hookBlock = buildPreCommitHookInstructions();
	const contextBlock = projectContext ? formatProjectContext(projectContext) : "";
	const depBlock = issue.dependency ? buildDependencyContext(issue.dependency) : "";
	const specWarningBlock = buildSpecWarningBlock(issue.specWarning);
	const contextMdBlock = buildContextMdBlock(repoContextMd ?? null);
	const prBase = issue.dependency ? issue.dependency.branch : baseBranch;
	const manifestLocation = manifestPath
		? `\`${manifestPath}\``
		: "`.lisa/manifests/default.json` in the **current directory**";
	const prCreateBlock = buildPrCreateInstruction(platform, prBase);

	return `You are an autonomous implementation agent. You MUST complete ALL steps below — implementation, commit, push, PR creation, and manifest file — before finishing.
Do NOT stop after implementing code. The task is NOT complete until the manifest file is written with the PR URL.
Do NOT use interactive skills, ask clarifying questions, or wait for user input. You are running unattended. No human will see your output or respond to questions. If the issue is too ambiguous to implement, you MUST STOP and provide a clear explanation.

You are working inside a git worktree that was automatically created for this task.
Work on the current branch — it was created for you.
${repoPath ? `\n**Working directory:** \`${repoPath}\`\nAll file paths are relative to this directory. Use this as the base for any absolute paths.\n` : ""}
## Issue

- **ID:** ${issue.id}
- **Title:** ${issue.title}
- **URL:** ${issue.url}

### Description

${issue.description}
${specWarningBlock}${contextBlock ? `\n${contextBlock}\n` : ""}${contextMdBlock}${depBlock ? `\n${depBlock}\n` : ""}
## Instructions

1. **Implement**: Follow the issue description exactly:
   - Read all relevant files listed in the description first (if present)
   - Follow the implementation instructions exactly
   - Verify each acceptance criteria (if present)
   - Respect any stack or technical constraints (if present)
${testBlock}${apiClientBlock}${hookBlock}
2. **Validate**: Run the project's linter/typecheck/tests if available:
   - Check \`package.json\` (or equivalent) for lint, typecheck, check, or test scripts.
   - Run whichever validation scripts exist (e.g., \`npm run lint\`, \`npm run typecheck\`).
   - Fix any errors before proceeding.
${readmeBlock}
**CRITICAL — Do NOT stop here. The following steps (commit, push, PR, manifest) are MANDATORY. Skipping them means the task has FAILED.**

3. **Commit**: Make atomic commits with conventional commit messages.
   **Branch name must be in English.** If the current branch name contains non-English words,
   rename it: \`git branch -m <current-name> feat/${issue.id.toLowerCase()}-short-english-slug\`
   **IMPORTANT — Language rules:**
   - All commit messages MUST be in English.
   - Use conventional commits format: \`feat: ...\`, \`fix: ...\`, \`refactor: ...\`, \`chore: ...\`

4. **Push**: Push the branch to origin:
   \`git push -u origin <branch-name>\`
   If the push fails due to a pre-push hook, read the error, fix the root cause, amend the commit, and retry. Do NOT use \`--no-verify\`.

5. ${prCreateBlock}

6. **Update tracker**: Call the lisa CLI to mark the issue as done:
   \`lisa issue done ${issue.id} --pr-url <pr-url>\`
   Wait 1 second before calling this command.

7. **Write manifest**: Create ${manifestLocation} with JSON:
   \`\`\`json
   {"branch": "<final English branch name>", "prUrl": "<pull request URL>"}
   \`\`\`
   Do NOT commit this file.

${buildRulesSection(projectContext?.environment)}

## Completion Checklist

Before finishing, verify ALL of the following are true:
- [ ] Code changes are committed (no uncommitted changes)
- [ ] Branch is pushed to origin
- [ ] Pull request is created and URL is captured
- [ ] Manifest file is written with \`prUrl\` field
If ANY item is unchecked, go back and complete it. Do NOT finish with incomplete steps.`;
}

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
	platform: PRPlatform = "cli",
	repoContextMd?: string | null,
): string {
	const testBlock = buildTestInstructions(testRunner ?? null, pm);
	const apiClientBlock = "";
	const headings = cwd ? extractReadmeHeadings(cwd) : [];
	const readmeBlock = buildReadmeInstructions(headings);
	const hookBlock = buildPreCommitHookInstructions();
	const contextBlock = projectContext ? formatProjectContext(projectContext) : "";
	const depBlock = issue.dependency ? buildDependencyContext(issue.dependency) : "";
	const specWarningBlock = buildSpecWarningBlock(issue.specWarning);
	const contextMdBlock = buildContextMdBlock(repoContextMd ?? null);
	const prBase = issue.dependency ? issue.dependency.branch : baseBranch;

	const previousBlock =
		previousResults.length > 0
			? `\n## Previous Steps\n\nThe following repos have already been implemented as part of this issue:\n\n${previousResults.map((r) => `- **${r.repoPath}**: branch \`${r.branch}\`${r.prUrl ? ` — PR: ${r.prUrl}` : ""}`).join("\n")}\n\nUse this context if the current step depends on changes from previous steps.\n`
			: "";

	const trackerStep = isLastStep
		? `\n6. **Update tracker**: Call \`lisa issue done ${issue.id} --pr-url <pr-url>\` (wait 1 second before calling).\n`
		: `\n6. **Skip tracker update**: This is not the last step. The caller handles the tracker update after all steps complete.\n`;

	return `You are an autonomous implementation agent. You MUST complete ALL steps below — implementation, commit, push, PR creation, and manifest file — before finishing.
Do NOT stop after implementing code. The task is NOT complete until the manifest file is written with the PR URL.
Do NOT use interactive skills, ask clarifying questions, or wait for user input. You are running unattended. No human will see your output or respond to questions.

You are working inside a git worktree that was automatically created for this task.
Work on the current branch — it was created for you.
${cwd ? `\n**Working directory:** \`${cwd}\`\nAll file paths are relative to this directory. Use this as the base for any absolute paths.\n` : ""}
## Issue

- **ID:** ${issue.id}
- **Title:** ${issue.title}
- **URL:** ${issue.url}

### Description

${issue.description}
${specWarningBlock}${contextBlock ? `\n${contextBlock}\n` : ""}${contextMdBlock}${depBlock ? `\n${depBlock}\n` : ""}
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
${testBlock}${apiClientBlock}${hookBlock}
2. **Validate**: Run the project's linter/typecheck/tests if available:
   - Check \`package.json\` (or equivalent) for lint, typecheck, check, or test scripts.
   - Run whichever validation scripts exist (e.g., \`npm run lint\`, \`npm run typecheck\`).
   - Fix any errors before proceeding.
${readmeBlock}
**CRITICAL — Do NOT stop here. The following steps (commit, push, PR, manifest) are MANDATORY. Skipping them means the task has FAILED.**

3. **Commit**: Make atomic commits with conventional commit messages.
   **Branch name must be in English.** If the current branch name contains non-English words,
   rename it: \`git branch -m <current-name> feat/${issue.id.toLowerCase()}-short-english-slug\`
   **IMPORTANT — Language rules:**
   - All commit messages MUST be in English.
   - Use conventional commits format: \`feat: ...\`, \`fix: ...\`, \`refactor: ...\`, \`chore: ...\`

4. **Push**: Push the branch to origin:
   \`git push -u origin <branch-name>\`
   If the push fails due to a pre-push hook, read the error, fix the root cause, amend the commit, and retry. Do NOT use \`--no-verify\`.

5. ${buildPrCreateInstruction(platform, prBase)}
${trackerStep}
7. **Write manifest**: Create ${manifestPath ? `\`${manifestPath}\`` : "`.lisa/manifests/default.json` in the **current directory**"} with JSON:
   \`\`\`json
   {"branch": "<final English branch name>", "prUrl": "<pull request URL>"}
   \`\`\`
   Do NOT commit this file.

${buildRulesSection(projectContext?.environment, "scope")}

## Completion Checklist

Before finishing, verify ALL of the following are true:
- [ ] Code changes are committed (no uncommitted changes)
- [ ] Branch is pushed to origin
- [ ] Pull request is created and URL is captured
- [ ] Manifest file is written with \`prUrl\` field
If ANY item is unchecked, go back and complete it. Do NOT finish with incomplete steps.`;
}

export interface ContinuationPromptOptions {
	issue: { id: string; title: string };
	diffStat: string;
	previousOutput: string;
	platform: PRPlatform;
	baseBranch: string;
	manifestPath: string;
}

export function buildContinuationPrompt(opts: ContinuationPromptOptions): string {
	const { issue, diffStat, platform, baseBranch, manifestPath } = opts;
	const prCreateBlock = buildPrCreateInstruction(platform, baseBranch);

	const outputLines = opts.previousOutput.split("\n");
	const truncatedOutput =
		outputLines.length > 50 ? outputLines.slice(-50).join("\n") : opts.previousOutput;

	return `You are an autonomous implementation agent resuming incomplete work.
A previous agent session made code changes but did NOT complete the delivery steps (commit, push, PR, manifest).
You MUST finish the job. Do NOT re-implement or undo existing changes — they are already in the working tree.
Do NOT use interactive skills, ask clarifying questions, or wait for user input. You are running unattended. No human will see your output or respond to questions.

## Issue

- **ID:** ${issue.id}
- **Title:** ${issue.title}

## Current State

The following files have been modified:
\`\`\`
${diffStat}
\`\`\`

## Previous Session Output (last lines)

\`\`\`
${truncatedOutput}
\`\`\`

## Instructions

1. **Review**: Run \`git diff\` to understand what was changed. Check if any work is obviously incomplete or broken. If critical files are missing changes, make minimal fixes.

2. **Validate**: Run the project's linter/typecheck/tests if available:
   - Check \`package.json\` (or equivalent) for lint, typecheck, check, or test scripts.
   - Run whichever validation scripts exist (e.g., \`npm run lint\`, \`npm run typecheck\`).
   - Fix any errors before proceeding.

**CRITICAL — Do NOT stop here. The following steps (commit, push, PR, manifest) are MANDATORY. Skipping them means the task has FAILED.**

3. **Commit**: Make atomic commits with conventional commit messages.
   **IMPORTANT — Language rules:**
   - All commit messages MUST be in English.
   - Use conventional commits format: \`feat: ...\`, \`fix: ...\`, \`refactor: ...\`, \`chore: ...\`

4. **Push**: Push the branch to origin:
   \`git push -u origin <branch-name>\`
   If the push fails due to a pre-push hook, read the error, fix the root cause, amend the commit, and retry. Do NOT use \`--no-verify\`.

5. ${prCreateBlock}

6. **Update tracker**: Call the lisa CLI to mark the issue as done:
   \`lisa issue done ${issue.id} --pr-url <pr-url>\`
   Wait 1 second before calling this command.

7. **Write manifest**: Create \`${manifestPath}\` with JSON:
   \`\`\`json
   {"branch": "<final English branch name>", "prUrl": "<pull request URL>"}
   \`\`\`
   Do NOT commit this file.

## Rules

- **ALL git commits, branch names, PR titles, and PR descriptions MUST be in English.**
- Do NOT install new dependencies.
- Do NOT use documentation lookup MCP tools.
- One issue only. Do not pick up additional issues.

## Completion Checklist

Before finishing, verify ALL of the following are true:
- [ ] Code changes are committed (no uncommitted changes)
- [ ] Branch is pushed to origin
- [ ] Pull request is created and URL is captured
- [ ] Manifest file is written with \`prUrl\` field
If ANY item is unchecked, go back and complete it. Do NOT finish with incomplete steps.`;
}
