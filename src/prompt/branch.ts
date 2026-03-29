import { resolve } from "node:path";
import type { ProjectContext } from "../context.js";
import { formatProjectContext } from "../context.js";
import { buildPrCreateInstruction } from "../git/platform.js";
import { getManifestPath } from "../paths.js";
import type { Issue, LisaConfig, PRPlatform } from "../types/index.js";
import {
	buildContextMdBlock,
	buildDefinitionOfDone,
	buildDependencyContext,
	buildPreCommitHookInstructions,
	buildReadmeInstructions,
	buildRulesSection,
	buildSpecWarningBlock,
	buildTaskTypeHint,
	buildTestInstructions,
	buildValidateStep,
	extractReadmeHeadings,
	GUARDRAILS_PLACEHOLDER,
} from "./shared.js";
import type { PackageManager, TestRunner } from "./types.js";

export interface BranchPromptContext {
	issue: Issue;
	testRunner: TestRunner;
	pm: PackageManager;
	baseBranch?: string;
	projectContext?: ProjectContext;
	manifestPath?: string;
	cwd?: string;
	platform: PRPlatform;
	repoContextMd: string | null;
	config: LisaConfig;
	relevantFiles: string | null;
	lineageBlock: string | null;
}

export function buildBranchInstructions(ctx: BranchPromptContext): string {
	const {
		issue,
		testRunner,
		pm,
		projectContext,
		cwd,
		platform,
		repoContextMd,
		config,
		relevantFiles,
		lineageBlock,
	} = ctx;

	const workspace = resolve(config.workspace);

	const testBlock = buildTestInstructions(testRunner, pm);
	const headings = cwd ? extractReadmeHeadings(cwd) : [];
	const readmeBlock = buildReadmeInstructions(headings);
	const hookBlock = buildPreCommitHookInstructions();
	const contextBlock = projectContext ? formatProjectContext(projectContext) : "";
	const depBlock = issue.dependency ? buildDependencyContext(issue.dependency) : "";
	const specWarningBlock = buildSpecWarningBlock(issue.specWarning);
	const contextMdBlock = buildContextMdBlock(repoContextMd);
	const dodBlock = buildDefinitionOfDone(issue.description ?? "");
	const relevantFilesBlock = relevantFiles ?? "";
	const prBase = issue.dependency ? issue.dependency.branch : ctx.baseBranch;
	const prCreateBlock = buildPrCreateInstruction(platform, prBase);
	const manifestPath = ctx.manifestPath ?? getManifestPath(resolve(config.workspace));

	const preamble =
		"You are an autonomous implementation agent. You MUST complete ALL steps below — implementation, commit, push, PR creation, and manifest file — before finishing.\nDo NOT stop after implementing code. The task is NOT complete until the manifest file is written with the PR URL.\nDo NOT use interactive skills, ask clarifying questions, or wait for user input. You are running unattended. No human will see your output or respond to questions. If the issue is too ambiguous to implement, you MUST STOP and provide a clear explanation.";

	const taskHint = buildTaskTypeHint(issue.title);

	const repoEntries = config.repos
		.map(
			(r) =>
				`   - If it says "Repo: ${r.name}" or title starts with "${r.match}" → \`${resolve(workspace, r.path)}\` (base branch: \`${r.base_branch}\`)`,
		)
		.join("\n");

	const baseBranchInstruction = issue.dependency
		? `From \`${issue.dependency.branch}\` (dependency branch)`
		: config.repos.length > 0
			? "From the repo's base branch (listed above)"
			: `From \`${ctx.baseBranch}\``;

	const instructions = `## Instructions

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
4. ${buildValidateStep(testRunner, pm)}
${readmeBlock}
**CRITICAL — Do NOT stop here. The following steps (commit, push, PR, manifest) are MANDATORY. Skipping them means the task has FAILED.**

5. **Commit & Push**: Make atomic commits with conventional commit messages.
   Push the branch to origin:
   \`git push -u origin <branch-name>\`
   If the push fails due to a pre-push hook, read the error, fix the root cause, amend the commit, and retry. Do NOT use \`--no-verify\`.
   **IMPORTANT — Language rules:**
   - All commit messages MUST be in English.
   - Use conventional commits format: \`feat: ...\`, \`fix: ...\`, \`refactor: ...\`, \`chore: ...\`

6. ${prCreateBlock}

7. **Update tracker**: Call the lisa CLI to mark the issue as done:
   \`lisa issue done ${issue.id} --pr-url <pr-url>\`
   Wait 1 second before calling this command.

8. **Write manifest**: Before finishing, create \`${manifestPath}\` with JSON:
   \`\`\`json
   {"repoPath": "<absolute path to this repo>", "branch": "<branch name>", "prUrl": "<pull request URL>"}
   \`\`\`
   Do NOT commit this file.`;

	const rulesSection = buildRulesSection(
		projectContext?.environment,
		"issue",
		"- Do NOT modify files outside the target repo.\n",
	);
	const lineageSection = lineageBlock ?? "";

	return `${preamble}${taskHint}
${contextBlock ? `\n${contextBlock}\n` : ""}${contextMdBlock}${relevantFilesBlock ? `\n${relevantFilesBlock}\n` : ""}${depBlock ? `\n${depBlock}\n` : ""}${lineageSection ? `\n${lineageSection}\n` : ""}
## Issue

- **ID:** ${issue.id}
- **Title:** ${issue.title}
- **URL:** ${issue.url}

### Description

${issue.description}
${specWarningBlock}${dodBlock}${GUARDRAILS_PLACEHOLDER}
${instructions}

${rulesSection}

## Completion Checklist

Before finishing, verify ALL of the following are true:
- [ ] Code changes are committed (no uncommitted changes)
- [ ] Branch is pushed to origin
- [ ] Pull request is created and URL is captured
- [ ] Manifest file is written with \`prUrl\` field
If ANY item is unchecked, go back and complete it. Do NOT finish with incomplete steps.`;
}
