import { buildPrCreateInstruction } from "../git/platform.js";
import type { ContinuationPromptOptions } from "./types.js";

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
