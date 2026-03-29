import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectEnvironment } from "../context.js";
import type { DependencyContext } from "../types/index.js";
import type { PackageManager, TestRunner } from "./types.js";

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

export function buildTestInstructions(testRunner: TestRunner, pm: PackageManager = "npm"): string {
	if (!testRunner) return "";

	const testCmd = pm === "bun" ? "bun run test" : `${pm} run test`;

	return `
**MANDATORY — Test-Driven Development (TDD):**
This project uses **${testRunner}**. Follow the RED → GREEN → REFACTOR cycle strictly:
1. **RED**: Write the failing tests first — before writing any implementation code.
   Run \`${testCmd}\` and confirm the new tests fail. If they pass immediately, the tests are wrong.
2. **GREEN**: Write the minimum implementation to make the tests pass.
   Run \`${testCmd}\` — all tests must pass before continuing.
3. **REFACTOR**: Clean up the code without breaking tests. Run \`${testCmd}\` one final time to confirm.
- Cover the main functionality, edge cases, and error scenarios.
- Do NOT write implementation before tests. The PR will be blocked if tests are missing or written after the fact.
`;
}

export function buildDefinitionOfDone(description: string): string {
	const criteria = description
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => /^- \[ \]/.test(l));

	if (criteria.length === 0) return "";

	return `\n## Definition of Done\n\nVerify each item before finishing:\n\n${criteria.join("\n")}\n`;
}

export function buildSpecWarningBlock(warning?: string): string {
	if (!warning) return "";
	return `\n> **Warning — incomplete spec:** ${warning}\n> Proceed using reasonable assumptions based on the title and description.\n> If the issue is genuinely too ambiguous to implement, STOP and explain what is missing.\n`;
}

export function buildRulesSection(
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

export function buildValidateStep(testRunner: TestRunner, pm: PackageManager = "npm"): string {
	const testCmd = pm === "bun" ? "bun run test" : `${pm} run test`;
	const testLine = testRunner
		? `   - Run \`${testCmd}\` — ALL tests must pass (final gate after the TDD cycle).\n`
		: "";
	return `**Validate**: Confirm all quality gates before committing:
${testLine}   - Run lint/typecheck scripts if available (e.g., \`npm run lint\`, \`npm run typecheck\`).
   - Fix every error. Do NOT commit with failing tests or lint errors.`;
}

export function buildPreCommitHookInstructions(): string {
	return `
**Pre-commit hooks:**
If \`git commit\` fails due to a pre-commit hook (e.g. husky), read the error output carefully and fix the underlying issue:
- Linter/formatter failures → run the project's lint/format commands, then re-stage and retry the commit.
- Code generation errors (e.g. stale Prisma client) → run the required generation command (e.g. \`npx prisma generate\`), then re-stage and retry.
- Type errors → fix the type issues in the source files, then re-stage and retry.
Do NOT skip or bypass hooks (no \`--no-verify\`). Fix the root cause and retry.
`;
}

export function buildReadmeInstructions(headings: string[]): string {
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

/**
 * Derive a lightweight attention hint from the issue title prefix.
 *
 * Research (PRISM — arxiv.org/html/2603.18507v1) shows that full expert
 * personas hurt factual recall while helping alignment tasks. Instead of
 * injecting a heavy persona, we add a short task-type-aware hint that steers
 * the model's attention without activating deep "instruction-following mode".
 */
export function buildTaskTypeHint(title: string): string {
	const lower = title.toLowerCase();

	if (/^\[?fix[\]:\s]|^bug[\s:-]|^hotfix[\s:-]/i.test(lower)) {
		return "\nPay special attention to understanding the existing code before making changes. Read related files thoroughly and verify the root cause before applying a fix.";
	}

	if (/^\[?refactor[\]:\s]/i.test(lower)) {
		return "\nPreserve all existing behavior. Run tests frequently during the refactor to catch regressions early.";
	}

	if (/^\[?test[\]:\s]|^add tests|^write tests/i.test(lower)) {
		return "\nFocus on meaningful test coverage. Read the source code to understand edge cases before writing tests.";
	}

	if (/^\[?docs?[\]:\s]|^documentation/i.test(lower)) {
		return "\nRead the current code to ensure documentation accurately reflects the actual behavior.";
	}

	return "";
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

/**
 * Sentinel inserted between the issue description and procedural instructions.
 * The provider layer replaces this with the actual guardrails content (if any)
 * so that past-failure context is read before the model enters execution mode.
 */
export const GUARDRAILS_PLACEHOLDER = "{{GUARDRAILS}}";
