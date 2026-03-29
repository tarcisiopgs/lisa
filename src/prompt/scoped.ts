import type { ProjectContext } from "../context.js";
import { formatProjectContext } from "../context.js";
import { buildPrCreateInstruction } from "../git/platform.js";
import type { Issue, PlanStep, PRPlatform } from "../types/index.js";
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
import type { PackageManager, PreviousStepResult, TestRunner } from "./types.js";

export interface ScopedPromptContext {
	issue: Issue;
	testRunner: TestRunner;
	pm: PackageManager;
	baseBranch?: string;
	projectContext?: ProjectContext;
	manifestPath?: string;
	cwd?: string;
	platform: PRPlatform;
	repoContextMd: string | null;
	step: PlanStep;
	previousResults: PreviousStepResult[];
	isLastStep: boolean;
	relevantFiles: string | null;
	lineageBlock: string | null;
}

export function buildScopedInstructions(ctx: ScopedPromptContext): string {
	const {
		issue,
		testRunner,
		pm,
		projectContext,
		cwd,
		platform,
		repoContextMd,
		step,
		previousResults,
		isLastStep,
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
		"You are an autonomous implementation agent. You MUST complete ALL steps below — implementation, commit, push, PR creation, and manifest file — before finishing.\nDo NOT stop after implementing code. The task is NOT complete until the manifest file is written with the PR URL.\nDo NOT use interactive skills, ask clarifying questions, or wait for user input. You are running unattended. No human will see your output or respond to questions.";

	const taskHint = buildTaskTypeHint(issue.title);

	const workContext = `\nYou are working inside a git worktree that was automatically created for this task.\nWork on the current branch — it was created for you.\n${cwd ? `\n**Working directory:** \`${cwd}\`\nAll file paths are relative to this directory. Use this as the base for any absolute paths.\n` : ""}`;

	// Scope section
	const previousBlock =
		previousResults.length > 0
			? `\n## Previous Steps\n\nThe following repos have already been implemented as part of this issue:\n\n${previousResults.map((r) => `- **${r.repoPath}**: branch \`${r.branch}\`${r.prUrl ? ` — PR: ${r.prUrl}` : ""}`).join("\n")}\n\nUse this context if the current step depends on changes from previous steps.\n`
			: "";

	const scopeSection = `\n## Your Scope\n\nYou are responsible for **this specific part** of the issue:\n\n> ${step.scope}\n\nFocus only on this scope. Do NOT implement changes outside this scope.\n${previousBlock}`;

	const trackerStep = isLastStep
		? `\n6. **Update tracker**: Call \`lisa issue done ${issue.id} --pr-url <pr-url>\` (wait 1 second before calling).\n`
		: `\n6. **Skip tracker update**: This is not the last step. The caller handles the tracker update after all steps complete.\n`;

	const instructions = `## Instructions

1. **Implement**: Follow the scope above. Read the full issue description for context, but only implement what is described in "Your Scope":
   - Read all relevant files first
   - Follow the implementation instructions exactly
   - Verify each acceptance criteria relevant to your scope
${testBlock}${hookBlock}
2. ${buildValidateStep(testRunner, pm)}
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
${trackerStep}
7. **Write manifest**: Create ${manifestLocation} with JSON:
   \`\`\`json
   {"branch": "<final English branch name>", "prUrl": "<pull request URL>"}
   \`\`\`
   Do NOT commit this file.`;

	const rulesSection = buildRulesSection(projectContext?.environment, "scope");
	const lineageSection = lineageBlock ?? "";

	return `${preamble}${taskHint}
${workContext}${contextBlock ? `\n${contextBlock}\n` : ""}${contextMdBlock}${relevantFilesBlock ? `\n${relevantFilesBlock}\n` : ""}${depBlock ? `\n${depBlock}\n` : ""}${lineageSection ? `\n${lineageSection}\n` : ""}
## Issue

- **ID:** ${issue.id}
- **Title:** ${issue.title}
- **URL:** ${issue.url}

### Description

${issue.description}
${specWarningBlock}${dodBlock}${scopeSection}${GUARDRAILS_PLACEHOLDER}
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
