import type { ProjectContext } from "../context.js";
import { formatProjectContext } from "../context.js";
import { buildPrCreateInstruction } from "../git/platform.js";
import type { Issue, PRPlatform } from "../types/index.js";
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

export interface WorktreePromptContext {
	issue: Issue;
	testRunner: TestRunner;
	pm: PackageManager;
	baseBranch?: string;
	projectContext?: ProjectContext;
	manifestPath?: string;
	cwd?: string;
	platform: PRPlatform;
	repoContextMd: string | null;
	relevantFiles: string | null;
	lineageBlock: string | null;
}

export function buildWorktreeInstructions(ctx: WorktreePromptContext): string {
	const {
		issue,
		testRunner,
		pm,
		projectContext,
		cwd,
		platform,
		repoContextMd,
		relevantFiles,
		lineageBlock,
	} = ctx;

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
	const manifestLocation = ctx.manifestPath
		? `\`${ctx.manifestPath}\``
		: "`.lisa/manifests/default.json` in the **current directory**";

	const preamble =
		"You are an autonomous implementation agent. You MUST complete ALL steps below — implementation, commit, push, PR creation, and manifest file — before finishing.\nDo NOT stop after implementing code. The task is NOT complete until the manifest file is written with the PR URL.\nDo NOT use interactive skills, ask clarifying questions, or wait for user input. You are running unattended. No human will see your output or respond to questions. If the issue is too ambiguous to implement, you MUST STOP and provide a clear explanation.";

	const taskHint = buildTaskTypeHint(issue.title);

	const workContext = `\nYou are already inside the correct repository worktree on the correct branch.\nDo NOT create a new branch — just work on the current one.\n${cwd ? `\n**Working directory:** \`${cwd}\`\nAll file paths are relative to this directory. Use this as the base for any absolute paths.\n` : ""}`;

	const branchRenameInstruction = `   rename it before committing using the single-argument form:\n   \`git branch -m feat/${issue.id.toLowerCase()}-short-english-slug\``;

	const instructions = `## Instructions

1. **Implement**: Follow the issue description exactly:
   - Read all relevant files listed in the description first (if present)
   - Follow the implementation instructions exactly
   - Verify each acceptance criteria (if present)
   - Respect any stack or technical constraints (if present)
${testBlock}${hookBlock}
2. ${buildValidateStep(testRunner, pm)}
${readmeBlock}
**CRITICAL — Do NOT stop here. The following steps (commit, push, PR, manifest) are MANDATORY. Skipping them means the task has FAILED.**

3. **Commit**: Make atomic commits with conventional commit messages.
   **Branch name must be in English.** If the current branch name contains non-English words,
${branchRenameInstruction}
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
   Do NOT commit this file.`;

	const rulesSection = buildRulesSection(projectContext?.environment);
	const lineageSection = lineageBlock ?? "";

	return `${preamble}${taskHint}
${workContext}${contextBlock ? `\n${contextBlock}\n` : ""}${contextMdBlock}${relevantFilesBlock ? `\n${relevantFilesBlock}\n` : ""}${depBlock ? `\n${depBlock}\n` : ""}${lineageSection ? `\n${lineageSection}\n` : ""}
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
