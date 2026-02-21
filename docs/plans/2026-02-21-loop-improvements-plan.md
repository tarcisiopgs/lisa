# Loop Improvements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add native Claude Code worktree support, pre-agent multi-repo planning, and PR description formatting improvements.

**Architecture:** Three independent features layered on the existing loop. Feature 1 (native worktree) modifies the provider interface and worktree session. Feature 2 (multi-repo planning) replaces `runWorktreeMultiRepoSession()` with a planning phase + sequential single-repo sessions that reuse Feature 1. Feature 3 (PR formatting) touches prompts and `buildPrBody()`.

**Tech Stack:** TypeScript, vitest, child_process.spawn

---

### Task 1: Add `sanitizePrBody()` and update `buildPrBody()`

The simplest feature — no interface changes needed. Start here to build confidence.

**Files:**
- Create: `src/pr-body.ts`
- Create: `src/pr-body.test.ts`
- Modify: `src/loop.ts:41-55` (move `buildPrBody` to use `sanitizePrBody`)

**Step 1: Write the failing tests**

Create `src/pr-body.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { sanitizePrBody } from "./pr-body.js";

describe("sanitizePrBody", () => {
	it("trims leading and trailing whitespace", () => {
		expect(sanitizePrBody("  hello world  ")).toBe("hello world");
	});

	it("trims leading and trailing blank lines", () => {
		expect(sanitizePrBody("\n\nhello\n\n")).toBe("hello");
	});

	it("normalizes * bullets to - bullets", () => {
		expect(sanitizePrBody("* item one\n* item two")).toBe("- item one\n- item two");
	});

	it("does not change - bullets", () => {
		expect(sanitizePrBody("- item one\n- item two")).toBe("- item one\n- item two");
	});

	it("normalizes nested * bullets to - bullets", () => {
		expect(sanitizePrBody("  * nested item")).toBe("  - nested item");
	});

	it("strips HTML tags", () => {
		expect(sanitizePrBody("hello <b>world</b>")).toBe("hello world");
	});

	it("strips self-closing HTML tags", () => {
		expect(sanitizePrBody("hello<br/>world")).toBe("helloworld");
	});

	it("converts wall of text to bullet points", () => {
		const wall = "Added new endpoint for users. Fixed validation bug. Updated tests to cover edge cases.";
		const result = sanitizePrBody(wall);
		expect(result).toContain("- Added new endpoint for users");
		expect(result).toContain("- Fixed validation bug");
		expect(result).toContain("- Updated tests to cover edge cases");
	});

	it("does not split text that already has newlines", () => {
		const formatted = "- Added new endpoint\n- Fixed bug";
		expect(sanitizePrBody(formatted)).toBe("- Added new endpoint\n- Fixed bug");
	});

	it("returns empty string for empty input", () => {
		expect(sanitizePrBody("")).toBe("");
	});

	it("returns empty string for whitespace-only input", () => {
		expect(sanitizePrBody("   \n\n  ")).toBe("");
	});

	it("preserves markdown formatting like bold and code", () => {
		expect(sanitizePrBody("**bold** and `code`")).toBe("**bold** and `code`");
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `npm run test -- src/pr-body.test.ts`
Expected: FAIL — module `./pr-body.js` does not exist

**Step 3: Write the implementation**

Create `src/pr-body.ts`:

```typescript
export function sanitizePrBody(raw: string): string {
	let text = raw.trim();
	if (!text) return "";

	// Strip HTML tags
	text = text.replace(/<[^>]*>/g, "");

	// Normalize * bullets to - bullets (only at line start, with optional leading whitespace)
	text = text.replace(/^(\s*)\* /gm, "$1- ");

	// If no newlines at all (wall of text), split on sentence boundaries
	if (!text.includes("\n")) {
		const sentences = text.match(/[^.!?]+[.!?]+/g);
		if (sentences && sentences.length > 1) {
			text = sentences.map((s) => `- ${s.trim()}`).join("\n");
		}
	}

	return text.trim();
}
```

**Step 4: Run tests to verify they pass**

Run: `npm run test -- src/pr-body.test.ts`
Expected: PASS

**Step 5: Update `buildPrBody` in `loop.ts` to use `sanitizePrBody`**

In `src/loop.ts`, add the import and modify `buildPrBody`:

Add import at the top (after line 6):
```typescript
import { sanitizePrBody } from "./pr-body.js";
```

Replace the `buildPrBody` function (lines 41-55):
```typescript
function buildPrBody(providerUsed: ProviderName, description?: string): string {
	const lines: string[] = [];

	if (description) {
		const sanitized = sanitizePrBody(description);
		if (sanitized) {
			lines.push("## Summary", "", sanitized, "");
		}
	}

	lines.push(
		"---",
		"",
		`Implemented by [lisa](https://github.com/tarcisiopgs/lisa) using **${providerUsed}**.`,
	);

	return lines.join("\n");
}
```

**Step 6: Run full test suite**

Run: `npm run test`
Expected: PASS

**Step 7: Run lint and typecheck**

Run: `npm run lint && npm run typecheck`
Expected: PASS

**Step 8: Commit**

```bash
git add src/pr-body.ts src/pr-body.test.ts src/loop.ts
git commit -m "feat: add PR body sanitization with post-processing cleanup"
```

---

### Task 2: Improve `prBody` instructions in all prompt templates

**Files:**
- Modify: `src/prompt.ts` (all 4 prompt builders that reference `prBody`)
- Modify: `src/prompt.test.ts` (add tests for the new template)

**Step 1: Write the failing tests**

Add to `src/prompt.test.ts`, inside the `describe("buildImplementPrompt")` block, add a new test in the worktree mode section:

```typescript
it("includes concrete prBody markdown template with example structure", () => {
	const prompt = buildImplementPrompt(makeIssue(), makeConfig({ workflow: "worktree" }));
	expect(prompt).toContain("**What**:");
	expect(prompt).toContain("**Why**:");
	expect(prompt).toContain("**Key changes**:");
	expect(prompt).toContain("**Testing**:");
});
```

Add the same test to the branch mode section:

```typescript
it("includes concrete prBody markdown template with example structure", () => {
	const prompt = buildImplementPrompt(makeIssue(), makeConfig({ workflow: "branch" }));
	expect(prompt).toContain("**What**:");
	expect(prompt).toContain("**Why**:");
	expect(prompt).toContain("**Key changes**:");
	expect(prompt).toContain("**Testing**:");
});
```

And for multi-repo:

```typescript
it("includes concrete prBody markdown template with example structure", () => {
	const prompt = buildWorktreeMultiRepoPrompt(makeIssue(), multiRepoConfig);
	expect(prompt).toContain("**What**:");
	expect(prompt).toContain("**Why**:");
	expect(prompt).toContain("**Key changes**:");
	expect(prompt).toContain("**Testing**:");
});
```

**Step 2: Run tests to verify they fail**

Run: `npm run test -- src/prompt.test.ts`
Expected: FAIL — prompts don't contain the new template structure yet

**Step 3: Create a shared helper and update all prompt templates**

In `src/prompt.ts`, add a new helper function after `buildReadmeInstructions()`:

```typescript
function buildPrBodyInstructions(): string {
	return `The \`prBody\` MUST follow this exact markdown structure:
   \`\`\`
   - **What**: one-line summary of the change
   - **Why**: motivation or issue context
   - **Key changes**:
     - \`src/foo.ts\` — added X functionality
     - \`src/bar.ts\` — refactored Y to support Z
   - **Testing**: what was validated (e.g. "all unit tests pass", "manually tested endpoint")
   \`\`\`
   Write in English. Do NOT write a wall of text — structure the summary using the template above.`;
}
```

Then in each prompt template, replace the existing `prBody` instruction paragraph with a call to `buildPrBodyInstructions()`.

In `buildWorktreePrompt` (the manifest step), replace:
```
   The \`prBody\` MUST use markdown formatting. Use bullet points (\`-\`) to list key changes, and optionally bold (\`**text**\`) for emphasis. Do NOT write a wall of text — structure the summary as a bulleted list. Describe WHAT was changed and WHY, mentioning key files modified, new behavior added, or bugs fixed. Write in English.
```
with:
```
   ${buildPrBodyInstructions()}
```

Do the same replacement in `buildBranchPrompt` and `buildWorktreeMultiRepoPrompt` — all three have the same paragraph to replace.

**Step 4: Run tests to verify they pass**

Run: `npm run test -- src/prompt.test.ts`
Expected: PASS

**Step 5: Run lint and typecheck**

Run: `npm run lint && npm run typecheck`
Expected: PASS

**Step 6: Commit**

```bash
git add src/prompt.ts src/prompt.test.ts
git commit -m "feat: add concrete prBody markdown template to all prompt builders"
```

---

### Task 3: Add `supportsNativeWorktree` to `Provider` interface and `RunOptions`

**Files:**
- Modify: `src/types.ts:77-83` (add `useNativeWorktree` to `RunOptions`)
- Modify: `src/types.ts:91-95` (add `supportsNativeWorktree` to `Provider`)

**Step 1: Add `useNativeWorktree` to `RunOptions`**

In `src/types.ts`, modify the `RunOptions` interface (line 77-83):

```typescript
export interface RunOptions {
	logFile: string;
	cwd: string;
	guardrailsDir?: string;
	issueId?: string;
	overseer?: OverseerConfig;
	useNativeWorktree?: boolean;
}
```

**Step 2: Add `supportsNativeWorktree` to `Provider`**

In `src/types.ts`, modify the `Provider` interface (line 91-95):

```typescript
export interface Provider {
	name: ProviderName;
	supportsNativeWorktree?: boolean;
	isAvailable(): Promise<boolean>;
	run(prompt: string, opts: RunOptions): Promise<RunResult>;
}
```

**Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS — optional properties don't break existing implementations

**Step 4: Run full test suite**

Run: `npm run test`
Expected: PASS

**Step 5: Commit**

```bash
git add src/types.ts
git commit -m "feat: add supportsNativeWorktree to Provider and useNativeWorktree to RunOptions"
```

---

### Task 4: Implement `--worktree` flag in `ClaudeProvider`

**Files:**
- Modify: `src/providers/claude.ts` (add flag + property)
- Modify: `src/providers/index.test.ts` (add test for the flag)

**Step 1: Write the failing test**

Add to `src/providers/index.test.ts`:

```typescript
describe("supportsNativeWorktree", () => {
	it("claude provider supports native worktree", () => {
		const provider = createProvider("claude");
		expect(provider.supportsNativeWorktree).toBe(true);
	});

	it("gemini provider does not support native worktree", () => {
		const provider = createProvider("gemini");
		expect(provider.supportsNativeWorktree).toBeFalsy();
	});

	it("opencode provider does not support native worktree", () => {
		const provider = createProvider("opencode");
		expect(provider.supportsNativeWorktree).toBeFalsy();
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `npm run test -- src/providers/index.test.ts`
Expected: FAIL — `supportsNativeWorktree` is undefined for claude

**Step 3: Add the property and flag logic to `ClaudeProvider`**

In `src/providers/claude.ts`, modify the class:

```typescript
export class ClaudeProvider implements Provider {
	name = "claude" as const;
	supportsNativeWorktree = true;

	async isAvailable(): Promise<boolean> {
		try {
			execSync("claude --version", { stdio: "ignore" });
			return true;
		} catch {
			return false;
		}
	}

	async run(prompt: string, opts: RunOptions): Promise<RunResult> {
		const start = Date.now();

		// Write prompt to temp file (avoids arg length limits, matches Ralph's pattern)
		const tmpDir = mkdtempSync(join(tmpdir(), "lisa-"));
		const promptFile = join(tmpDir, "prompt.md");
		writeFileSync(promptFile, prompt, "utf-8");

		try {
			const flags = ["-p", "--dangerously-skip-permissions"];
			if (opts.useNativeWorktree) {
				flags.push("--worktree");
			}

			const proc = spawn(
				"sh",
				["-c", `claude ${flags.join(" ")} "$(cat '${promptFile}')"`],
				{
					cwd: opts.cwd,
					stdio: ["ignore", "pipe", "pipe"],
					env: { ...process.env, CLAUDECODE: undefined },
				},
			);

			// ... rest of the method stays the same
```

**Step 4: Run tests to verify they pass**

Run: `npm run test -- src/providers/index.test.ts`
Expected: PASS

**Step 5: Run lint and typecheck**

Run: `npm run lint && npm run typecheck`
Expected: PASS

**Step 6: Commit**

```bash
git add src/providers/claude.ts src/providers/index.test.ts
git commit -m "feat: add --worktree flag support to ClaudeProvider"
```

---

### Task 5: Expose provider instance from `runWithFallback`

The loop needs to check `supportsNativeWorktree` before deciding the worktree strategy. Currently `runWithFallback` only returns `FallbackResult` which doesn't include the provider instance.

**Files:**
- Modify: `src/types.ts:104-110` (add `provider` to `FallbackResult`)
- Modify: `src/providers/index.ts:62-140` (include provider in result)

**Step 1: Add `provider` to `FallbackResult`**

In `src/types.ts`, modify `FallbackResult`:

```typescript
export interface FallbackResult {
	success: boolean;
	output: string;
	duration: number;
	providerUsed: ProviderName;
	provider?: Provider;
	attempts: ModelAttempt[];
}
```

**Step 2: Update `runWithFallback` to include the provider instance**

In `src/providers/index.ts`, modify the success return (around line 94):

```typescript
		if (result.success) {
			attempts.push({
				provider: model,
				success: true,
				duration: result.duration,
			});
			return {
				success: true,
				output: result.output,
				duration: result.duration,
				providerUsed: model,
				provider,
				attempts,
			};
		}
```

And the non-eligible error return (around line 122):

```typescript
		if (!eligible) {
			return {
				success: false,
				output: result.output,
				duration: result.duration,
				providerUsed: model,
				provider,
				attempts,
			};
		}
```

**Step 3: Run typecheck and tests**

Run: `npm run typecheck && npm run test`
Expected: PASS — `provider` is optional so no breakage

**Step 4: Commit**

```bash
git add src/types.ts src/providers/index.ts
git commit -m "feat: expose provider instance in FallbackResult"
```

---

### Task 6: Add `buildNativeWorktreePrompt` to prompt.ts

**Files:**
- Modify: `src/prompt.ts` (add new exported function)
- Modify: `src/prompt.test.ts` (add tests)

**Step 1: Write the failing tests**

Add to `src/prompt.test.ts`:

```typescript
import { buildImplementPrompt, buildNativeWorktreePrompt, buildWorktreeMultiRepoPrompt, detectTestRunner } from "./prompt.js";
```

Then add a new `describe` block:

```typescript
describe("buildNativeWorktreePrompt", () => {
	it("includes issue details", () => {
		const prompt = buildNativeWorktreePrompt(makeIssue());
		expect(prompt).toContain("INT-100");
		expect(prompt).toContain("Add feature X");
		expect(prompt).toContain("Implement the feature X as described.");
	});

	it("tells agent it is in a worktree managed by the tool", () => {
		const prompt = buildNativeWorktreePrompt(makeIssue());
		expect(prompt).toContain("worktree");
		expect(prompt).not.toContain("Do NOT create a new branch");
	});

	it("instructs agent NOT to push", () => {
		const prompt = buildNativeWorktreePrompt(makeIssue());
		expect(prompt).toContain("Do NOT push");
	});

	it("includes manifest instructions with branch field", () => {
		const prompt = buildNativeWorktreePrompt(makeIssue());
		expect(prompt).toContain(".lisa-manifest.json");
		expect(prompt).toContain('"branch"');
	});

	it("includes concrete prBody template", () => {
		const prompt = buildNativeWorktreePrompt(makeIssue());
		expect(prompt).toContain("**What**:");
		expect(prompt).toContain("**Key changes**:");
	});

	it("includes test instructions when runner is provided", () => {
		const prompt = buildNativeWorktreePrompt(makeIssue(), "vitest");
		expect(prompt).toContain("MANDATORY — Unit Tests");
		expect(prompt).toContain("vitest");
	});

	it("includes README evaluation instructions", () => {
		const prompt = buildNativeWorktreePrompt(makeIssue());
		expect(prompt).toContain("README.md Evaluation");
	});

	it("includes English language rules", () => {
		const prompt = buildNativeWorktreePrompt(makeIssue());
		expect(prompt).toContain("ALL git commits, branch names, PR titles, and PR descriptions MUST be in English");
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `npm run test -- src/prompt.test.ts`
Expected: FAIL — `buildNativeWorktreePrompt` does not exist

**Step 3: Implement `buildNativeWorktreePrompt`**

In `src/prompt.ts`, add and export:

```typescript
export function buildNativeWorktreePrompt(issue: Issue, testRunner?: TestRunner): string {
	const testBlock = buildTestInstructions(testRunner ?? null);
	const readmeBlock = buildReadmeInstructions();
	const hookBlock = buildPreCommitHookInstructions();
	const prBodyBlock = buildPrBodyInstructions();

	return `You are an autonomous implementation agent. Your job is to implement a single
issue, validate it, and commit.

You are working inside a git worktree that was automatically created for this task.
Work on the current branch — it was created for you.

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
${testBlock}${readmeBlock}${hookBlock}
2. **Validate**: Run the project's linter/typecheck/tests if available:
   - Check \`package.json\` (or equivalent) for lint, typecheck, check, or test scripts.
   - Run whichever validation scripts exist (e.g., \`npm run lint\`, \`npm run typecheck\`).
   - Fix any errors before proceeding.

3. **Commit**: Make atomic commits with conventional commit messages.
   **Branch name must be in English.** If the current branch name contains non-English words,
   rename it: \`git branch -m <current-name> feat/${issue.id.toLowerCase()}-short-english-slug\`
   Do NOT push — the caller handles pushing.
   **IMPORTANT — Language rules:**
   - All commit messages MUST be in English.
   - Use conventional commits format: \`feat: ...\`, \`fix: ...\`, \`refactor: ...\`, \`chore: ...\`

4. **Write manifest**: Create \`.lisa-manifest.json\` in the **current directory** with JSON:
   \`\`\`json
   {"branch": "<final English branch name>", "prTitle": "<English PR title, conventional commit format>", "prBody": "<markdown-formatted English summary>"}
   \`\`\`
   ${prBodyBlock}
   Do NOT commit this file.

## Rules

- **ALL git commits, branch names, PR titles, and PR descriptions MUST be in English.**
- The issue description may be in any language — read it for context but write all code artifacts in English.
- Do NOT push — the caller handles that.
- Do NOT install new dependencies unless the issue explicitly requires it.
- If you get stuck or the issue is unclear, STOP and explain why.
- One issue only. Do not pick up additional issues.
- If the repo has a CLAUDE.md, read it first and follow its conventions.
- Do NOT create pull requests — the caller handles that.
- Do NOT update the issue tracker — the caller handles that.`;
}
```

**Step 4: Run tests to verify they pass**

Run: `npm run test -- src/prompt.test.ts`
Expected: PASS

**Step 5: Run lint and typecheck**

Run: `npm run lint && npm run typecheck`
Expected: PASS

**Step 6: Commit**

```bash
git add src/prompt.ts src/prompt.test.ts
git commit -m "feat: add buildNativeWorktreePrompt for Claude Code --worktree sessions"
```

---

### Task 7: Update `runWorktreeSession` for native worktree support

This is the core loop change. When the first provider in the model chain supports native worktree, skip Lisa's manual worktree creation.

**Files:**
- Modify: `src/loop.ts:523-712` (`runWorktreeSession`)
- Modify: `src/loop.ts:1-23` (imports)

**Step 1: Add import for `buildNativeWorktreePrompt`**

In `src/loop.ts`, update the import from `./prompt.js` (line 8):

```typescript
import {
	buildImplementPrompt,
	buildNativeWorktreePrompt,
	buildPushRecoveryPrompt,
	buildWorktreeMultiRepoPrompt,
	detectTestRunner,
} from "./prompt.js";
```

Also add `createProvider` import from providers:

```typescript
import { createProvider, runWithFallback } from "./providers/index.js";
```

**Step 2: Add helper to check if first model supports native worktree**

Add a helper function in `loop.ts`:

```typescript
function firstModelSupportsNativeWorktree(models: ProviderName[]): boolean {
	const first = models[0];
	if (!first) return false;
	const provider = createProvider(first);
	return provider.supportsNativeWorktree === true;
}
```

**Step 3: Refactor `runWorktreeSession` with conditional worktree flow**

The key change is: if `firstModelSupportsNativeWorktree(models)` is true, skip the `createWorktree`/`removeWorktree` calls, use the repo root as cwd, pass `useNativeWorktree: true`, and use `buildNativeWorktreePrompt` instead of `buildImplementPrompt`.

Modify `runWorktreeSession` (starting at line 523). The logic becomes:

```typescript
async function runWorktreeSession(
	config: LisaConfig,
	issue: { id: string; title: string; url: string; description: string; repo?: string },
	logFile: string,
	session: number,
	models: ProviderName[],
): Promise<SessionResult> {
	// Multi-repo: run planning phase + sequential single-repo sessions
	if (config.repos.length > 1) {
		return runWorktreeMultiRepoSession(config, issue, logFile, session, models);
	}

	const workspace = resolve(config.workspace);
	const repoPath = determineRepoPath(config.repos, issue, workspace) ?? workspace;
	const defaultBranch = resolveBaseBranch(config, repoPath);
	const useNativeWorktree = firstModelSupportsNativeWorktree(models);

	let worktreePath: string | null = null;
	let effectiveCwd: string;

	if (useNativeWorktree) {
		// Claude Code handles worktree creation/cleanup via --worktree
		logger.log("Using native worktree support (--worktree)");
		effectiveCwd = repoPath;
	} else {
		// Lisa manages worktree lifecycle manually
		const branchName = generateBranchName(issue.id, issue.title);
		startSpinner(`${issue.id} — creating worktree...`);
		logger.log(`Creating worktree for ${branchName} (base: ${defaultBranch})...`);

		try {
			worktreePath = await createWorktree(repoPath, branchName, defaultBranch);
		} catch (err) {
			stopSpinner();
			logger.error(`Failed to create worktree: ${err instanceof Error ? err.message : String(err)}`);
			return {
				success: false,
				providerUsed: models[0] ?? "claude",
				prUrls: [],
				fallback: {
					success: false, output: "", duration: 0,
					providerUsed: models[0] ?? "claude", attempts: [],
				},
			};
		}

		stopSpinner();
		logger.ok(`Worktree created at ${worktreePath}`);
		effectiveCwd = worktreePath;
	}

	// Start lifecycle resources
	const repo = findRepoConfig(config, issue);
	if (repo?.lifecycle) {
		startSpinner(`${issue.id} — starting resources...`);
		const started = await startResources(repo, effectiveCwd);
		stopSpinner();
		if (!started) {
			logger.error(`Lifecycle startup failed for ${issue.id}. Aborting session.`);
			if (worktreePath) await cleanupWorktree(repoPath, worktreePath);
			return {
				success: false,
				providerUsed: models[0] ?? "claude",
				prUrls: [],
				fallback: {
					success: false, output: "", duration: 0,
					providerUsed: models[0] ?? "claude", attempts: [],
				},
			};
		}
	}

	// Build prompt based on worktree strategy
	const testRunner = detectTestRunner(effectiveCwd);
	if (testRunner) logger.log(`Detected test runner: ${testRunner}`);

	const prompt = useNativeWorktree
		? buildNativeWorktreePrompt(issue, testRunner)
		: buildImplementPrompt(issue, config, testRunner);

	startSpinner(`${issue.id} — implementing...`);
	logger.log(`Implementing${useNativeWorktree ? " (native worktree)" : " in worktree"}... (log: ${logFile})`);
	logger.initLogFile(logFile);

	const result = await runWithFallback(models, prompt, {
		logFile,
		cwd: effectiveCwd,
		guardrailsDir: repoPath,
		issueId: issue.id,
		overseer: config.overseer,
		useNativeWorktree,
	});
	stopSpinner();

	try {
		appendFileSync(
			logFile,
			`\n${"=".repeat(80)}\nProvider used: ${result.providerUsed}\nFull output:\n${result.output}\n`,
		);
	} catch {}

	if (repo?.lifecycle) await stopResources();

	if (!result.success) {
		logger.error(`Session ${session} failed for ${issue.id}. Check ${logFile}`);
		if (worktreePath) await cleanupWorktree(repoPath, worktreePath);
		return { success: false, providerUsed: result.providerUsed, prUrls: [], fallback: result };
	}

	// Read manifest — location depends on worktree strategy
	const manifestDir = useNativeWorktree ? repoPath : (worktreePath ?? repoPath);
	const manifest = readLisaManifest(manifestDir);

	// For native worktree, agent writes the branch name in manifest
	// For manual worktree, we may need to rename branch
	let effectiveBranch: string;

	if (useNativeWorktree) {
		if (!manifest?.branch) {
			logger.error(`Agent did not produce a manifest with branch name for ${issue.id}. Aborting.`);
			return { success: false, providerUsed: result.providerUsed, prUrls: [], fallback: result };
		}
		effectiveBranch = manifest.branch;
		logger.ok(`Agent used branch: ${effectiveBranch}`);

		// For native worktree, we need to find the worktree path for push/test operations
		// The agent worked in a worktree, but we need to locate it
		// Check if the branch exists in a worktree under .worktrees or .claude/worktrees
		const possibleWorktreePaths = [
			join(repoPath, ".worktrees", effectiveBranch),
			join(repoPath, ".claude", "worktrees", effectiveBranch),
		];
		const nativeWorktreePath = possibleWorktreePaths.find((p) => existsSync(p));
		if (nativeWorktreePath) {
			effectiveCwd = nativeWorktreePath;
		}
		// If not found, the branch may be on the repo root (agent may have checked out)
	} else {
		const branchName = generateBranchName(issue.id, issue.title);
		effectiveBranch = branchName;
		if (manifest?.branch && manifest.branch !== branchName) {
			logger.log(`Renaming branch to English name: ${manifest.branch}`);
			try {
				await execa("git", ["branch", "-m", branchName, manifest.branch], { cwd: worktreePath! });
				effectiveBranch = manifest.branch;
				logger.ok(`Branch renamed to ${effectiveBranch}`);
			} catch (err) {
				logger.warn(`Branch rename failed, using original: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}

	// Validate tests
	startSpinner(`${issue.id} — validating tests...`);
	const testsPassed = await runTestValidation(effectiveCwd);
	stopSpinner();
	if (!testsPassed) {
		logger.error(`Tests failed for ${issue.id}. Blocking PR creation.`);
		if (worktreePath) await cleanupWorktree(repoPath, worktreePath);
		cleanupManifest(manifestDir);
		return { success: false, providerUsed: result.providerUsed, prUrls: [], fallback: result };
	}

	// Push
	startSpinner(`${issue.id} — pushing...`);
	const pushResult = await pushWithRecovery({
		branch: effectiveBranch,
		cwd: effectiveCwd,
		models,
		logFile,
		guardrailsDir: repoPath,
		issueId: issue.id,
		overseer: config.overseer,
	});
	stopSpinner();
	if (!pushResult.success) {
		logger.error(`Failed to push branch to remote: ${pushResult.error}`);
		cleanupManifest(manifestDir);
		if (worktreePath) await cleanupWorktree(repoPath, worktreePath);
		return { success: false, providerUsed: result.providerUsed, prUrls: [], fallback: result };
	}

	// Create PR
	startSpinner(`${issue.id} — creating PR...`);
	const prTitle = manifest?.prTitle ?? readPrTitle(effectiveCwd) ?? issue.title;
	const prBody = manifest?.prBody;
	cleanupPrTitle(effectiveCwd);
	cleanupManifest(manifestDir);

	const prUrls: string[] = [];
	try {
		const repoInfo = await getRepoInfo(effectiveCwd);
		const pr = await createPullRequest(
			{
				owner: repoInfo.owner,
				repo: repoInfo.repo,
				head: effectiveBranch,
				base: defaultBranch,
				title: prTitle,
				body: buildPrBody(result.providerUsed, prBody),
			},
			config.github,
		);
		logger.ok(`PR created: ${pr.html_url}`);
		prUrls.push(pr.html_url);
	} catch (err) {
		logger.error(`Failed to create PR: ${err instanceof Error ? err.message : String(err)}`);
	}
	stopSpinner();

	if (worktreePath) await cleanupWorktree(repoPath, worktreePath);

	logger.ok(`Session ${session} complete for ${issue.id}`);
	return { success: true, providerUsed: result.providerUsed, prUrls, fallback: result };
}
```

**Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 5: Run full test suite**

Run: `npm run test`
Expected: PASS

**Step 6: Run lint**

Run: `npm run lint`
Expected: PASS (fix any issues)

**Step 7: Commit**

```bash
git add src/loop.ts
git commit -m "feat: add native worktree support to runWorktreeSession"
```

---

### Task 8: Add `PlanStep` and `ExecutionPlan` types

**Files:**
- Modify: `src/types.ts` (add new interfaces at the end)

**Step 1: Add the types**

In `src/types.ts`, add at the end before the closing:

```typescript
export interface PlanStep {
	repoPath: string;
	scope: string;
	order: number;
}

export interface ExecutionPlan {
	steps: PlanStep[];
}
```

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add PlanStep and ExecutionPlan types for multi-repo planning"
```

---

### Task 9: Add `buildPlanningPrompt` and `buildScopedImplementPrompt`

**Files:**
- Modify: `src/prompt.ts` (add two new exported functions)
- Modify: `src/prompt.test.ts` (add tests)

**Step 1: Write the failing tests**

Add to `src/prompt.test.ts`:

```typescript
import {
	buildImplementPrompt,
	buildNativeWorktreePrompt,
	buildPlanningPrompt,
	buildScopedImplementPrompt,
	buildWorktreeMultiRepoPrompt,
	detectTestRunner,
} from "./prompt.js";
import type { Issue, LisaConfig, PlanStep } from "./types.js";
```

Add new describe blocks:

```typescript
describe("buildPlanningPrompt", () => {
	const multiRepoConfig = makeConfig({
		workflow: "worktree",
		workspace: "/tmp/workspace",
		repos: [
			{ name: "api", path: "./api", match: "API:", base_branch: "main" },
			{ name: "web", path: "./web", match: "Web:", base_branch: "main" },
		],
	});

	it("includes issue details", () => {
		const prompt = buildPlanningPrompt(makeIssue(), multiRepoConfig);
		expect(prompt).toContain("INT-100");
		expect(prompt).toContain("Add feature X");
	});

	it("lists all available repos", () => {
		const prompt = buildPlanningPrompt(makeIssue(), multiRepoConfig);
		expect(prompt).toContain("api");
		expect(prompt).toContain("web");
	});

	it("instructs agent to NOT implement", () => {
		const prompt = buildPlanningPrompt(makeIssue(), multiRepoConfig);
		expect(prompt).toContain("Do NOT implement");
	});

	it("instructs agent to write .lisa-plan.json", () => {
		const prompt = buildPlanningPrompt(makeIssue(), multiRepoConfig);
		expect(prompt).toContain(".lisa-plan.json");
	});

	it("includes the plan JSON structure", () => {
		const prompt = buildPlanningPrompt(makeIssue(), multiRepoConfig);
		expect(prompt).toContain('"steps"');
		expect(prompt).toContain('"repoPath"');
		expect(prompt).toContain('"scope"');
		expect(prompt).toContain('"order"');
	});
});

describe("buildScopedImplementPrompt", () => {
	const step: PlanStep = {
		repoPath: "/tmp/workspace/api",
		scope: "Add new REST endpoint for user profiles",
		order: 1,
	};

	it("includes issue details", () => {
		const prompt = buildScopedImplementPrompt(makeIssue(), step, []);
		expect(prompt).toContain("INT-100");
		expect(prompt).toContain("Add feature X");
	});

	it("includes the step scope", () => {
		const prompt = buildScopedImplementPrompt(makeIssue(), step, []);
		expect(prompt).toContain("Add new REST endpoint for user profiles");
	});

	it("includes previous results when provided", () => {
		const prev = [{ repoPath: "/tmp/workspace/db", branch: "feat/int-100-add-migration", prUrl: "https://github.com/org/db/pull/42" }];
		const prompt = buildScopedImplementPrompt(makeIssue(), step, prev);
		expect(prompt).toContain("feat/int-100-add-migration");
		expect(prompt).toContain("https://github.com/org/db/pull/42");
	});

	it("does not include previous results section when empty", () => {
		const prompt = buildScopedImplementPrompt(makeIssue(), step, []);
		expect(prompt).not.toContain("Previous Steps");
	});

	it("includes manifest instructions", () => {
		const prompt = buildScopedImplementPrompt(makeIssue(), step, []);
		expect(prompt).toContain(".lisa-manifest.json");
	});

	it("includes concrete prBody template", () => {
		const prompt = buildScopedImplementPrompt(makeIssue(), step, []);
		expect(prompt).toContain("**What**:");
		expect(prompt).toContain("**Key changes**:");
	});

	it("instructs agent NOT to push", () => {
		const prompt = buildScopedImplementPrompt(makeIssue(), step, []);
		expect(prompt).toContain("Do NOT push");
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `npm run test -- src/prompt.test.ts`
Expected: FAIL — functions don't exist

**Step 3: Implement both functions**

In `src/prompt.ts`, add the import for `PlanStep`:

```typescript
import type { Issue, LisaConfig, PlanStep } from "./types.js";
```

Add `buildPlanningPrompt`:

```typescript
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
- Do NOT push, create pull requests, or update the issue tracker.
- If only one repo is affected, the plan should have a single step.`;
}
```

Add `buildScopedImplementPrompt`:

```typescript
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
): string {
	const testBlock = buildTestInstructions(testRunner ?? null);
	const readmeBlock = buildReadmeInstructions();
	const hookBlock = buildPreCommitHookInstructions();
	const prBodyBlock = buildPrBodyInstructions();

	const previousBlock =
		previousResults.length > 0
			? `\n## Previous Steps\n\nThe following repos have already been implemented as part of this issue:\n\n${previousResults.map((r) => `- **${r.repoPath}**: branch \`${r.branch}\`${r.prUrl ? ` — PR: ${r.prUrl}` : ""}`).join("\n")}\n\nUse this context if the current step depends on changes from previous steps.\n`
			: "";

	return `You are an autonomous implementation agent. Your job is to implement a specific part of an issue in a single repository.

You are working inside a git worktree that was automatically created for this task.
Work on the current branch — it was created for you.

## Issue

- **ID:** ${issue.id}
- **Title:** ${issue.title}
- **URL:** ${issue.url}

### Description

${issue.description}

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
   Do NOT push — the caller handles pushing.
   **IMPORTANT — Language rules:**
   - All commit messages MUST be in English.
   - Use conventional commits format: \`feat: ...\`, \`fix: ...\`, \`refactor: ...\`, \`chore: ...\`

4. **Write manifest**: Create \`.lisa-manifest.json\` in the **current directory** with JSON:
   \`\`\`json
   {"branch": "<final English branch name>", "prTitle": "<English PR title, conventional commit format>", "prBody": "<markdown-formatted English summary>"}
   \`\`\`
   ${prBodyBlock}
   Do NOT commit this file.

## Rules

- **ALL git commits, branch names, PR titles, and PR descriptions MUST be in English.**
- The issue description may be in any language — read it for context but write all code artifacts in English.
- Do NOT push — the caller handles that.
- Do NOT install new dependencies unless the issue explicitly requires it.
- If you get stuck or the issue is unclear, STOP and explain why.
- One scope only. Do not pick up additional work outside your scope.
- If the repo has a CLAUDE.md, read it first and follow its conventions.
- Do NOT create pull requests — the caller handles that.
- Do NOT update the issue tracker — the caller handles that.`;
}
```

**Step 4: Run tests to verify they pass**

Run: `npm run test -- src/prompt.test.ts`
Expected: PASS

**Step 5: Run lint and typecheck**

Run: `npm run lint && npm run typecheck`
Expected: PASS

**Step 6: Commit**

```bash
git add src/prompt.ts src/prompt.test.ts
git commit -m "feat: add buildPlanningPrompt and buildScopedImplementPrompt for multi-repo planning"
```

---

### Task 10: Replace `runWorktreeMultiRepoSession` with planning + sequential sessions

This is the core multi-repo refactor. Replace the existing function with one that runs a planning phase, reads the plan, then executes sequential single-repo sessions.

**Files:**
- Modify: `src/loop.ts` (replace `runWorktreeMultiRepoSession`, add plan reading, add sequential loop)

**Step 1: Add plan reading helpers**

In `src/loop.ts`, add after the manifest helpers:

```typescript
const PLAN_FILE = ".lisa-plan.json";

function readLisaPlan(dir: string): import("./types.js").ExecutionPlan | null {
	const planPath = join(dir, PLAN_FILE);
	if (!existsSync(planPath)) return null;
	try {
		return JSON.parse(readFileSync(planPath, "utf-8").trim()) as import("./types.js").ExecutionPlan;
	} catch {
		return null;
	}
}

function cleanupPlan(dir: string): void {
	try {
		unlinkSync(join(dir, PLAN_FILE));
	} catch {}
}
```

**Step 2: Add imports**

Update the imports in `src/loop.ts`:

```typescript
import {
	buildImplementPrompt,
	buildNativeWorktreePrompt,
	buildPlanningPrompt,
	buildPushRecoveryPrompt,
	buildScopedImplementPrompt,
	detectTestRunner,
	type PreviousStepResult,
} from "./prompt.js";
```

**Step 3: Rewrite `runWorktreeMultiRepoSession`**

Replace the entire `runWorktreeMultiRepoSession` function:

```typescript
async function runWorktreeMultiRepoSession(
	config: LisaConfig,
	issue: { id: string; title: string; url: string; description: string; repo?: string },
	logFile: string,
	session: number,
	models: ProviderName[],
): Promise<SessionResult> {
	const workspace = resolve(config.workspace);

	// Clean stale artifacts from previous interrupted runs
	cleanupManifest(workspace);
	cleanupPlan(workspace);

	// === Phase 1: Planning ===
	startSpinner(`${issue.id} — analyzing issue...`);
	logger.log(`Multi-repo planning phase for ${issue.id}`);

	const planningPrompt = buildPlanningPrompt(issue, config);
	const planResult = await runWithFallback(models, planningPrompt, {
		logFile,
		cwd: workspace,
		guardrailsDir: workspace,
		issueId: issue.id,
		overseer: config.overseer,
	});
	stopSpinner();

	if (!planResult.success) {
		logger.error(`Planning phase failed for ${issue.id}. Check ${logFile}`);
		cleanupPlan(workspace);
		return { success: false, providerUsed: planResult.providerUsed, prUrls: [], fallback: planResult };
	}

	const plan = readLisaPlan(workspace);
	cleanupPlan(workspace);

	if (!plan || !plan.steps || plan.steps.length === 0) {
		logger.error(`Agent did not produce a valid .lisa-plan.json for ${issue.id}. Aborting.`);
		return { success: false, providerUsed: planResult.providerUsed, prUrls: [], fallback: planResult };
	}

	// Validate: all repo paths must exist in config
	const validRepoPaths = new Set(config.repos.map((r) => resolve(workspace, r.path)));
	for (const step of plan.steps) {
		if (!validRepoPaths.has(step.repoPath)) {
			logger.error(`Plan references unknown repo path: ${step.repoPath}. Aborting.`);
			return { success: false, providerUsed: planResult.providerUsed, prUrls: [], fallback: planResult };
		}
	}

	// Sort steps by order
	const sortedSteps = [...plan.steps].sort((a, b) => a.order - b.order);
	logger.ok(`Plan: ${sortedSteps.length} repo(s) to implement`);
	for (const step of sortedSteps) {
		logger.log(`  ${step.order}. ${step.repoPath} — ${step.scope}`);
	}

	// === Phase 2: Sequential Implementation ===
	const allPrUrls: string[] = [];
	const previousResults: PreviousStepResult[] = [];
	let lastProviderUsed = planResult.providerUsed;

	for (const step of sortedSteps) {
		const repoPath = step.repoPath;
		const baseBranch = resolveBaseBranch(config, repoPath);
		const useNativeWorktree = firstModelSupportsNativeWorktree(models);

		logger.divider(session);
		logger.log(`Step ${step.order}: ${repoPath} — ${step.scope}`);

		let worktreePath: string | null = null;
		let effectiveCwd: string;

		if (useNativeWorktree) {
			logger.log("Using native worktree support (--worktree)");
			effectiveCwd = repoPath;
		} else {
			const branchName = generateBranchName(issue.id, issue.title);
			startSpinner(`${issue.id} — creating worktree for step ${step.order}...`);
			try {
				worktreePath = await createWorktree(repoPath, branchName, baseBranch);
			} catch (err) {
				stopSpinner();
				logger.error(`Failed to create worktree: ${err instanceof Error ? err.message : String(err)}`);
				return {
					success: allPrUrls.length > 0,
					providerUsed: lastProviderUsed,
					prUrls: allPrUrls,
					fallback: planResult,
				};
			}
			stopSpinner();
			logger.ok(`Worktree created at ${worktreePath}`);
			effectiveCwd = worktreePath;
		}

		// Start lifecycle resources
		const repo = config.repos.find((r) => resolve(workspace, r.path) === repoPath);
		if (repo?.lifecycle) {
			startSpinner(`${issue.id} — starting resources for step ${step.order}...`);
			const started = await startResources(repo, effectiveCwd);
			stopSpinner();
			if (!started) {
				logger.error(`Lifecycle startup failed for step ${step.order}. Skipping.`);
				if (worktreePath) await cleanupWorktree(repoPath, worktreePath);
				continue;
			}
		}

		// Build scoped prompt
		const testRunner = detectTestRunner(effectiveCwd);
		const prompt = buildScopedImplementPrompt(issue, step, previousResults, testRunner);

		startSpinner(`${issue.id} — implementing step ${step.order}...`);
		logger.initLogFile(logFile);

		const result = await runWithFallback(models, prompt, {
			logFile,
			cwd: effectiveCwd,
			guardrailsDir: repoPath,
			issueId: issue.id,
			overseer: config.overseer,
			useNativeWorktree,
		});
		stopSpinner();
		lastProviderUsed = result.providerUsed;

		try {
			appendFileSync(
				logFile,
				`\n${"=".repeat(80)}\nStep ${step.order} — Provider: ${result.providerUsed}\n`,
			);
		} catch {}

		if (repo?.lifecycle) await stopResources();

		if (!result.success) {
			logger.error(`Step ${step.order} failed for ${issue.id}. Continuing with remaining steps.`);
			if (worktreePath) await cleanupWorktree(repoPath, worktreePath);
			continue;
		}

		// Read manifest
		const manifestDir = useNativeWorktree ? repoPath : (worktreePath ?? repoPath);
		const manifest = readLisaManifest(manifestDir);

		let effectiveBranch: string;
		if (useNativeWorktree) {
			if (!manifest?.branch) {
				logger.error(`No branch in manifest for step ${step.order}. Skipping PR.`);
				cleanupManifest(manifestDir);
				continue;
			}
			effectiveBranch = manifest.branch;
			// Try to find native worktree path for push
			const possiblePaths = [
				join(repoPath, ".worktrees", effectiveBranch),
				join(repoPath, ".claude", "worktrees", effectiveBranch),
			];
			const nwPath = possiblePaths.find((p) => existsSync(p));
			if (nwPath) effectiveCwd = nwPath;
		} else {
			const branchName = generateBranchName(issue.id, issue.title);
			effectiveBranch = branchName;
			if (manifest?.branch && manifest.branch !== branchName) {
				try {
					await execa("git", ["branch", "-m", branchName, manifest.branch], { cwd: worktreePath! });
					effectiveBranch = manifest.branch;
				} catch {}
			}
		}

		// Validate tests
		startSpinner(`${issue.id} — validating tests for step ${step.order}...`);
		const testsPassed = await runTestValidation(effectiveCwd);
		stopSpinner();
		if (!testsPassed) {
			logger.error(`Tests failed for step ${step.order}. Skipping PR.`);
			if (worktreePath) await cleanupWorktree(repoPath, worktreePath);
			cleanupManifest(manifestDir);
			continue;
		}

		// Push
		startSpinner(`${issue.id} — pushing step ${step.order}...`);
		const pushResult = await pushWithRecovery({
			branch: effectiveBranch,
			cwd: effectiveCwd,
			models,
			logFile,
			guardrailsDir: repoPath,
			issueId: issue.id,
			overseer: config.overseer,
		});
		stopSpinner();
		if (!pushResult.success) {
			logger.error(`Push failed for step ${step.order}: ${pushResult.error}`);
			if (worktreePath) await cleanupWorktree(repoPath, worktreePath);
			cleanupManifest(manifestDir);
			continue;
		}

		// Create PR
		startSpinner(`${issue.id} — creating PR for step ${step.order}...`);
		const prTitle = manifest?.prTitle ?? issue.title;
		const prBody = manifest?.prBody;
		cleanupManifest(manifestDir);

		try {
			const repoInfo = await getRepoInfo(effectiveCwd);
			const pr = await createPullRequest(
				{
					owner: repoInfo.owner,
					repo: repoInfo.repo,
					head: effectiveBranch,
					base: baseBranch,
					title: prTitle,
					body: buildPrBody(result.providerUsed, prBody),
				},
				config.github,
			);
			logger.ok(`PR created for step ${step.order}: ${pr.html_url}`);
			allPrUrls.push(pr.html_url);
			previousResults.push({ repoPath, branch: effectiveBranch, prUrl: pr.html_url });
		} catch (err) {
			logger.error(`Failed to create PR for step ${step.order}: ${err instanceof Error ? err.message : String(err)}`);
			previousResults.push({ repoPath, branch: effectiveBranch });
		}
		stopSpinner();

		if (worktreePath) await cleanupWorktree(repoPath, worktreePath);
	}

	logger.ok(`Session ${session} complete for ${issue.id} (${allPrUrls.length} PR(s) created)`);
	return {
		success: allPrUrls.length > 0,
		providerUsed: lastProviderUsed,
		prUrls: allPrUrls,
		fallback: planResult,
	};
}
```

**Step 4: Remove old `buildWorktreeMultiRepoPrompt` import**

In `src/loop.ts`, remove `buildWorktreeMultiRepoPrompt` from the import (it's no longer used in loop.ts):

```typescript
import {
	buildImplementPrompt,
	buildNativeWorktreePrompt,
	buildPlanningPrompt,
	buildPushRecoveryPrompt,
	buildScopedImplementPrompt,
	detectTestRunner,
	type PreviousStepResult,
} from "./prompt.js";
```

**Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 6: Run full test suite**

Run: `npm run test`
Expected: PASS

**Step 7: Run lint**

Run: `npm run lint`
Expected: PASS (fix any issues)

**Step 8: Commit**

```bash
git add src/loop.ts
git commit -m "feat: replace multi-repo session with planning phase + sequential implementation"
```

---

### Task 11: Update existing prompt tests for prBody template change

Since Task 2 changed the prBody instructions, verify that existing tests still match. If any tests asserted on the old wording, update them.

**Files:**
- Modify: `src/prompt.test.ts` (if needed)

**Step 1: Run the full test suite**

Run: `npm run test`
Expected: PASS — if tests fail, update assertions to match new wording

**Step 2: Run lint and typecheck**

Run: `npm run lint && npm run typecheck`
Expected: PASS

**Step 3: Commit (if changes were needed)**

```bash
git add src/prompt.test.ts
git commit -m "test: update prompt tests for new prBody template"
```

---

### Task 12: Build, link, and verify end-to-end

**Files:** None (verification only)

**Step 1: Build**

Run: `npm run build`
Expected: PASS — `dist/index.js` produced

**Step 2: Link**

Run: `npm link`
Expected: `lisa` CLI available globally

**Step 3: Verify dry-run**

Run: `lisa run --dry-run`
Expected: Prints dry-run output without errors

**Step 4: Run the full CI check**

Run: `npm run ci`
Expected: PASS — lint + typecheck + test all green

**Step 5: Final commit (if any fixups needed)**

```bash
git add -A
git commit -m "chore: fix build issues from loop improvements"
```
