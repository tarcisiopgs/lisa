import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectContext } from "./context.js";
import {
	buildDependencyContext,
	buildImplementPrompt,
	buildNativeWorktreePrompt,
	buildPlanningPrompt,
	buildScopedImplementPrompt,
	detectTestRunner,
	extractReadmeHeadings,
} from "./prompt.js";
import type { DependencyContext, Issue, LisaConfig, PlanStep } from "./types/index.js";

function makeIssue(overrides?: Partial<Issue>): Issue {
	return {
		id: "INT-100",
		title: "Add feature X",
		description: "Implement the feature X as described.",
		url: "https://linear.app/team/issue/INT-100/add-feature-x",
		...overrides,
	};
}

function makeConfig(overrides?: Partial<LisaConfig>): LisaConfig {
	return {
		provider: "claude",
		source: "linear",
		source_config: {
			team: "Team",
			project: "Project",
			label: "lisa",
			pick_from: "Todo",
			in_progress: "In Progress",
			done: "Done",
		},
		platform: "cli",
		workflow: "worktree",
		workspace: "/tmp/workspace",
		base_branch: "main",
		repos: [],
		loop: { cooldown: 0, max_sessions: 0 },
		...overrides,
	};
}

describe("detectTestRunner", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "lisa-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns 'vitest' when vitest is in devDependencies", () => {
		writeFileSync(
			join(tmpDir, "package.json"),
			JSON.stringify({ devDependencies: { vitest: "^1.0.0" } }),
		);
		expect(detectTestRunner(tmpDir)).toBe("vitest");
	});

	it("returns 'jest' when jest is in devDependencies", () => {
		writeFileSync(
			join(tmpDir, "package.json"),
			JSON.stringify({ devDependencies: { jest: "^29.0.0" } }),
		);
		expect(detectTestRunner(tmpDir)).toBe("jest");
	});

	it("returns 'vitest' when vitest is in dependencies", () => {
		writeFileSync(
			join(tmpDir, "package.json"),
			JSON.stringify({ dependencies: { vitest: "^1.0.0" } }),
		);
		expect(detectTestRunner(tmpDir)).toBe("vitest");
	});

	it("returns null when no test runner is found", () => {
		writeFileSync(
			join(tmpDir, "package.json"),
			JSON.stringify({ devDependencies: { typescript: "^5.0.0" } }),
		);
		expect(detectTestRunner(tmpDir)).toBeNull();
	});

	it("returns null when package.json does not exist", () => {
		expect(detectTestRunner(tmpDir)).toBeNull();
	});

	it("returns null when package.json is invalid JSON", () => {
		writeFileSync(join(tmpDir, "package.json"), "not valid json{{{");
		expect(detectTestRunner(tmpDir)).toBeNull();
	});

	it("prefers vitest over jest when both are present", () => {
		writeFileSync(
			join(tmpDir, "package.json"),
			JSON.stringify({ devDependencies: { vitest: "^1.0.0", jest: "^29.0.0" } }),
		);
		expect(detectTestRunner(tmpDir)).toBe("vitest");
	});
});

describe("extractReadmeHeadings", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "lisa-readme-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("extracts headings from README.md", () => {
		writeFileSync(
			join(tmpDir, "README.md"),
			"# Lisa\n\n## Getting Started\n\nSome text.\n\n### Installation\n\n### Configuration\n\n## Usage\n",
		);
		expect(extractReadmeHeadings(tmpDir)).toEqual([
			"# Lisa",
			"## Getting Started",
			"### Installation",
			"### Configuration",
			"## Usage",
		]);
	});

	it("returns empty array when no README exists", () => {
		expect(extractReadmeHeadings(tmpDir)).toEqual([]);
	});

	it("returns empty array when README has no headings", () => {
		writeFileSync(join(tmpDir, "README.md"), "Just some text without headings.\n");
		expect(extractReadmeHeadings(tmpDir)).toEqual([]);
	});

	it("handles all heading levels (h1-h6)", () => {
		writeFileSync(join(tmpDir, "README.md"), "# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6\n");
		expect(extractReadmeHeadings(tmpDir)).toEqual([
			"# H1",
			"## H2",
			"### H3",
			"#### H4",
			"##### H5",
			"###### H6",
		]);
	});

	it("ignores lines that look like headings but are not", () => {
		writeFileSync(
			join(tmpDir, "README.md"),
			"# Real Heading\n#not a heading\n##also not\nSome #inline hash\n",
		);
		expect(extractReadmeHeadings(tmpDir)).toEqual(["# Real Heading"]);
	});
});

describe("buildImplementPrompt", () => {
	describe("worktree mode", () => {
		it("includes issue details in the prompt", () => {
			const issue = makeIssue();
			const config = makeConfig({ workflow: "worktree" });
			const prompt = buildImplementPrompt(issue, config);

			expect(prompt).toContain("INT-100");
			expect(prompt).toContain("Add feature X");
			expect(prompt).toContain("Implement the feature X as described.");
			expect(prompt).toContain("https://linear.app/team/issue/INT-100/add-feature-x");
		});

		it("includes worktree-specific instructions", () => {
			const prompt = buildImplementPrompt(makeIssue(), makeConfig({ workflow: "worktree" }));

			expect(prompt).toContain("inside the correct repository worktree");
			expect(prompt).toContain("Do NOT create a new branch");
		});

		it("does not include test instructions when no test runner is provided", () => {
			const prompt = buildImplementPrompt(makeIssue(), makeConfig({ workflow: "worktree" }));

			expect(prompt).not.toContain("MANDATORY — Unit Tests");
			expect(prompt).not.toContain("*.test.ts");
		});

		it("includes test instructions when vitest is detected", () => {
			const prompt = buildImplementPrompt(
				makeIssue(),
				makeConfig({ workflow: "worktree" }),
				"vitest",
			);

			expect(prompt).toContain("MANDATORY — Unit Tests");
			expect(prompt).toContain("vitest");
			expect(prompt).toContain("*.test.ts");
			expect(prompt).toContain("npm run test");
		});

		it("includes test instructions when jest is detected", () => {
			const prompt = buildImplementPrompt(
				makeIssue(),
				makeConfig({ workflow: "worktree" }),
				"jest",
			);

			expect(prompt).toContain("MANDATORY — Unit Tests");
			expect(prompt).toContain("jest");
		});

		it("includes README validation instructions when cwd has README", () => {
			const tmpDir = mkdtempSync(join(tmpdir(), "lisa-readme-"));
			writeFileSync(join(tmpDir, "README.md"), "# Project\n## Installation\n## Usage\n");
			const prompt = buildImplementPrompt(
				makeIssue(),
				makeConfig({ workflow: "worktree" }),
				undefined,
				undefined,
				undefined,
				tmpDir,
			);

			expect(prompt).toContain("README.md Validation");
			expect(prompt).toContain("# Project");
			expect(prompt).toContain("## Installation");
			expect(prompt).toContain("## Usage");
			expect(prompt).toContain("CLI commands, flags, or usage examples");
			rmSync(tmpDir, { recursive: true, force: true });
		});

		it("omits README instructions when no cwd provided", () => {
			const prompt = buildImplementPrompt(makeIssue(), makeConfig({ workflow: "worktree" }));
			expect(prompt).not.toContain("README.md Validation");
		});

		it("omits README instructions when cwd has no README", () => {
			const tmpDir = mkdtempSync(join(tmpdir(), "lisa-no-readme-"));
			const prompt = buildImplementPrompt(
				makeIssue(),
				makeConfig({ workflow: "worktree" }),
				undefined,
				undefined,
				undefined,
				tmpDir,
			);
			expect(prompt).not.toContain("README.md Validation");
			rmSync(tmpDir, { recursive: true, force: true });
		});

		it("places README block in Validate step, not Implement step", () => {
			const tmpDir = mkdtempSync(join(tmpdir(), "lisa-readme-"));
			writeFileSync(join(tmpDir, "README.md"), "# Project\n## Usage\n");
			const prompt = buildImplementPrompt(
				makeIssue(),
				makeConfig({ workflow: "worktree" }),
				undefined,
				undefined,
				undefined,
				tmpDir,
			);

			const implementIndex = prompt.indexOf("1. **Implement**");
			const validateIndex = prompt.indexOf("2. **Validate**");
			const readmeIndex = prompt.indexOf("README.md Validation");
			const commitIndex = prompt.indexOf("3. **Commit**");

			expect(readmeIndex).toBeGreaterThan(validateIndex);
			expect(readmeIndex).toBeLessThan(commitIndex);
			expect(readmeIndex).toBeGreaterThan(implementIndex);
			rmSync(tmpDir, { recursive: true, force: true });
		});
	});

	describe("branch mode", () => {
		it("includes branch-specific instructions with English name requirement", () => {
			const prompt = buildImplementPrompt(makeIssue(), makeConfig({ workflow: "branch" }));

			expect(prompt).toContain("Create a branch");
			expect(prompt).toContain("feat/int-100-short-english-description");
			expect(prompt).toContain("MUST be in English");
		});

		it("includes repo entries when repos are configured", () => {
			const config = makeConfig({
				workflow: "branch",
				repos: [
					{ name: "app", path: "./app", match: "App:", base_branch: "main" },
					{ name: "api", path: "./api", match: "API:", base_branch: "develop" },
				],
			});
			const prompt = buildImplementPrompt(makeIssue(), config);

			expect(prompt).toContain("Repo: app");
			expect(prompt).toContain("Repo: api");
		});

		it("does not include test instructions when no test runner", () => {
			const prompt = buildImplementPrompt(makeIssue(), makeConfig({ workflow: "branch" }));

			expect(prompt).not.toContain("MANDATORY — Unit Tests");
		});

		it("includes test instructions when test runner is provided", () => {
			const prompt = buildImplementPrompt(
				makeIssue(),
				makeConfig({ workflow: "branch" }),
				"vitest",
			);

			expect(prompt).toContain("MANDATORY — Unit Tests");
			expect(prompt).toContain("vitest");
		});

		it("includes README validation instructions when cwd has README", () => {
			const tmpDir = mkdtempSync(join(tmpdir(), "lisa-readme-"));
			writeFileSync(join(tmpDir, "README.md"), "# App\n## API Reference\n");
			const prompt = buildImplementPrompt(
				makeIssue(),
				makeConfig({ workflow: "branch" }),
				undefined,
				undefined,
				undefined,
				tmpDir,
			);

			expect(prompt).toContain("README.md Validation");
			expect(prompt).toContain("# App");
			expect(prompt).toContain("## API Reference");
			rmSync(tmpDir, { recursive: true, force: true });
		});

		it("omits README instructions when no cwd provided in branch mode", () => {
			const prompt = buildImplementPrompt(makeIssue(), makeConfig({ workflow: "branch" }));
			expect(prompt).not.toContain("README.md Validation");
		});
	});

	describe("manifest path override", () => {
		it("uses explicit manifestPath in worktree mode when provided", () => {
			const prompt = buildImplementPrompt(
				makeIssue(),
				makeConfig({ workflow: "worktree" }),
				undefined,
				undefined,
				undefined,
				undefined,
				"/path/to/worktree/.lisa-manifest.json",
			);
			expect(prompt).toContain("/path/to/worktree/.lisa-manifest.json");
		});

		it("falls back to cache-dir manifest when no manifestPath provided in worktree mode", () => {
			const prompt = buildImplementPrompt(makeIssue(), makeConfig({ workflow: "worktree" }));
			// Cache-dir path ends in manifest.json (e.g., ~/.cache/lisa/<hash>/manifest.json)
			expect(prompt).toContain("manifest.json");
		});

		it("uses explicit manifestPath in branch mode when provided", () => {
			const prompt = buildImplementPrompt(
				makeIssue(),
				makeConfig({ workflow: "branch" }),
				undefined,
				undefined,
				undefined,
				undefined,
				"/workspace/.lisa-manifest.json",
			);
			expect(prompt).toContain("/workspace/.lisa-manifest.json");
		});

		it("falls back to cache-dir manifest when no manifestPath provided in branch mode", () => {
			const prompt = buildImplementPrompt(makeIssue(), makeConfig({ workflow: "branch" }));
			// Cache-dir path ends in manifest.json (e.g., ~/.cache/lisa/<hash>/manifest.json)
			expect(prompt).toContain("manifest.json");
		});
	});
});

describe("buildNativeWorktreePrompt", () => {
	it("includes issue details", () => {
		const prompt = buildNativeWorktreePrompt(makeIssue());
		expect(prompt).toContain("INT-100");
		expect(prompt).toContain("Add feature X");
		expect(prompt).toContain("Implement the feature X as described.");
	});

	it("mentions working inside a git worktree", () => {
		const prompt = buildNativeWorktreePrompt(makeIssue());
		expect(prompt).toContain("git worktree");
		expect(prompt).toContain("current branch");
	});

	it("includes manifest instructions", () => {
		const prompt = buildNativeWorktreePrompt(makeIssue());
		expect(prompt).toContain(".lisa-manifest.json");
	});

	it("writes manifest to manifestPath when provided", () => {
		const prompt = buildNativeWorktreePrompt(
			makeIssue(),
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			"/tmp/cache/manifest.json",
		);
		expect(prompt).toContain("/tmp/cache/manifest.json");
	});

	it("writes manifest to current directory when manifestPath not provided", () => {
		const prompt = buildNativeWorktreePrompt(makeIssue());
		expect(prompt).toContain("in the **current directory**");
	});

	it("includes test instructions when provided", () => {
		const prompt = buildNativeWorktreePrompt(makeIssue(), undefined, "vitest");
		expect(prompt).toContain("MANDATORY — Unit Tests");
		expect(prompt).toContain("vitest");
	});

	it("excludes test instructions when no runner", () => {
		const prompt = buildNativeWorktreePrompt(makeIssue());
		expect(prompt).not.toContain("MANDATORY — Unit Tests");
	});

	it("includes README validation instructions when repoPath has README", () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "lisa-readme-"));
		writeFileSync(join(tmpDir, "README.md"), "# Native Project\n## Docs\n");
		const prompt = buildNativeWorktreePrompt(makeIssue(), tmpDir);
		expect(prompt).toContain("README.md Validation");
		expect(prompt).toContain("# Native Project");
		expect(prompt).toContain("## Docs");
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("omits README instructions when no repoPath provided", () => {
		const prompt = buildNativeWorktreePrompt(makeIssue());
		expect(prompt).not.toContain("README.md Validation");
	});

	it("includes English-only rules", () => {
		const prompt = buildNativeWorktreePrompt(makeIssue());
		expect(prompt).toContain("MUST be in English");
	});
});

describe("buildPlanningPrompt", () => {
	const multiRepoConfig = makeConfig({
		workspace: "/tmp/workspace",
		repos: [
			{ name: "api", path: "./api", match: "API:", base_branch: "main" },
			{ name: "admin", path: "./admin", match: "Admin:", base_branch: "main" },
		],
	});

	it("includes issue details", () => {
		const prompt = buildPlanningPrompt(makeIssue(), multiRepoConfig);
		expect(prompt).toContain("INT-100");
		expect(prompt).toContain("Add feature X");
		expect(prompt).toContain("Implement the feature X as described.");
	});

	it("lists available repositories", () => {
		const prompt = buildPlanningPrompt(makeIssue(), multiRepoConfig);
		expect(prompt).toContain("api");
		expect(prompt).toContain("admin");
		expect(prompt).toContain("/tmp/workspace/api");
		expect(prompt).toContain("/tmp/workspace/admin");
	});

	it("instructs not to implement", () => {
		const prompt = buildPlanningPrompt(makeIssue(), multiRepoConfig);
		expect(prompt).toContain("Do NOT implement anything");
	});

	it("mentions plan file path", () => {
		const prompt = buildPlanningPrompt(makeIssue(), multiRepoConfig);
		expect(prompt).toContain("plan.json");
	});

	it("describes JSON structure with steps", () => {
		const prompt = buildPlanningPrompt(makeIssue(), multiRepoConfig);
		expect(prompt).toContain('"steps"');
		expect(prompt).toContain('"repoPath"');
		expect(prompt).toContain('"scope"');
		expect(prompt).toContain('"order"');
	});

	it("uses explicit planPath when provided", () => {
		const prompt = buildPlanningPrompt(
			makeIssue(),
			multiRepoConfig,
			"/workspace/.lisa-plan-INT_100.json",
		);
		expect(prompt).toContain("/workspace/.lisa-plan-INT_100.json");
	});

	it("falls back to cache-dir plan path when no planPath provided", () => {
		const prompt = buildPlanningPrompt(makeIssue(), multiRepoConfig);
		expect(prompt).toContain("plan.json");
	});
});

describe("buildScopedImplementPrompt", () => {
	const step: PlanStep = {
		repoPath: "/tmp/workspace/api",
		scope: "Add rate limiting middleware to Express routes",
		order: 1,
	};

	it("includes issue details", () => {
		const prompt = buildScopedImplementPrompt(makeIssue(), step, []);
		expect(prompt).toContain("INT-100");
		expect(prompt).toContain("Add feature X");
	});

	it("includes the step scope", () => {
		const prompt = buildScopedImplementPrompt(makeIssue(), step, []);
		expect(prompt).toContain("Add rate limiting middleware to Express routes");
		expect(prompt).toContain("Your Scope");
	});

	it("includes previous results when provided", () => {
		const prompt = buildScopedImplementPrompt(makeIssue(), step, [
			{ repoPath: "/tmp/workspace/shared", branch: "feat/int-100-shared-types" },
		]);
		expect(prompt).toContain("Previous Steps");
		expect(prompt).toContain("/tmp/workspace/shared");
		expect(prompt).toContain("feat/int-100-shared-types");
	});

	it("includes PR URL in previous results when available", () => {
		const prompt = buildScopedImplementPrompt(makeIssue(), step, [
			{
				repoPath: "/tmp/workspace/shared",
				branch: "feat/int-100-shared",
				prUrl: "https://github.com/org/shared/pull/42",
			},
		]);
		expect(prompt).toContain("https://github.com/org/shared/pull/42");
	});

	it("omits previous steps section when empty", () => {
		const prompt = buildScopedImplementPrompt(makeIssue(), step, []);
		expect(prompt).not.toContain("Previous Steps");
	});

	it("includes manifest instructions", () => {
		const prompt = buildScopedImplementPrompt(makeIssue(), step, []);
		expect(prompt).toContain(".lisa-manifest.json");
	});

	it("includes test instructions when provided", () => {
		const prompt = buildScopedImplementPrompt(makeIssue(), step, [], "vitest");
		expect(prompt).toContain("MANDATORY — Unit Tests");
		expect(prompt).toContain("vitest");
	});
});

describe("prompt delegation — provider does push/PR/tracker", () => {
	it("worktree prompt instructs provider to push", () => {
		const prompt = buildImplementPrompt(makeIssue(), makeConfig({ workflow: "worktree" }));
		expect(prompt).toContain("git push -u origin");
	});

	it("worktree prompt instructs provider to create PR via gh", () => {
		const prompt = buildImplementPrompt(makeIssue(), makeConfig({ workflow: "worktree" }));
		expect(prompt).toContain("gh pr create");
	});

	it("worktree prompt instructs provider to call lisa issue done", () => {
		const prompt = buildImplementPrompt(makeIssue(), makeConfig({ workflow: "worktree" }));
		expect(prompt).toContain("lisa issue done");
	});

	it("worktree prompt uses prUrl in manifest (not prTitle/prBody)", () => {
		const prompt = buildImplementPrompt(makeIssue(), makeConfig({ workflow: "worktree" }));
		expect(prompt).toContain("prUrl");
		expect(prompt).not.toContain("prTitle");
		expect(prompt).not.toContain("prBody");
	});

	it("worktree prompt does not tell provider to skip push", () => {
		const prompt = buildImplementPrompt(makeIssue(), makeConfig({ workflow: "worktree" }));
		expect(prompt).not.toContain("Do NOT push");
	});

	it("scoped prompt with isLastStep=true includes lisa issue done", () => {
		const step: PlanStep = { repoPath: "/tmp/repo", scope: "implement feature", order: 1 };
		const prompt = buildScopedImplementPrompt(makeIssue(), step, [], undefined, undefined, true);
		expect(prompt).toContain("lisa issue done");
	});

	it("scoped prompt with isLastStep=false skips lisa issue done", () => {
		const step: PlanStep = { repoPath: "/tmp/repo", scope: "implement feature", order: 1 };
		const prompt = buildScopedImplementPrompt(makeIssue(), step, [], undefined, undefined, false);
		expect(prompt).toContain("Skip tracker update");
		expect(prompt).not.toContain("lisa issue done");
	});
});

function makeProjectContext(overrides?: Partial<ProjectContext>): ProjectContext {
	return {
		qualityScripts: [
			{ name: "lint", command: "biome lint" },
			{ name: "test", command: "vitest run" },
		],
		testPattern: {
			location: "colocated",
			style: "describe-it",
			mocking: ["vi.mock/vi.fn"],
			example: '// src/utils.test.ts\nimport { describe, it } from "vitest";',
		},
		codeTools: [{ name: "Biome", configFile: "biome.json" }],
		projectTree: "src/\n  index.ts\npackage.json",
		environment: "unknown",
		...overrides,
	};
}

describe("project context injection", () => {
	const ctx = makeProjectContext();

	it("worktree prompt includes project context when provided", () => {
		const prompt = buildImplementPrompt(
			makeIssue(),
			makeConfig({ workflow: "worktree" }),
			"vitest",
			"npm",
			ctx,
		);
		expect(prompt).toContain("## Project Context");
		expect(prompt).toContain("### Quality Scripts");
		expect(prompt).toContain("`lint`: `biome lint`");
		expect(prompt).toContain("### Test Patterns");
		expect(prompt).toContain("### Code Tools");
		expect(prompt).toContain("**Biome**");
		expect(prompt).toContain("### Project Structure");
	});

	it("worktree prompt omits project context when not provided", () => {
		const prompt = buildImplementPrompt(
			makeIssue(),
			makeConfig({ workflow: "worktree" }),
			"vitest",
		);
		expect(prompt).not.toContain("## Project Context");
	});

	it("branch prompt includes project context when provided", () => {
		const prompt = buildImplementPrompt(
			makeIssue(),
			makeConfig({ workflow: "branch" }),
			"vitest",
			"npm",
			ctx,
		);
		expect(prompt).toContain("## Project Context");
		expect(prompt).toContain("### Quality Scripts");
	});

	it("branch prompt omits project context when not provided", () => {
		const prompt = buildImplementPrompt(makeIssue(), makeConfig({ workflow: "branch" }), "vitest");
		expect(prompt).not.toContain("## Project Context");
	});

	it("native worktree prompt includes project context when provided", () => {
		const prompt = buildNativeWorktreePrompt(
			makeIssue(),
			"/tmp/repo",
			"vitest",
			"npm",
			"main",
			ctx,
		);
		expect(prompt).toContain("## Project Context");
		expect(prompt).toContain("### Quality Scripts");
		expect(prompt).toContain("### Test Patterns");
		expect(prompt).toContain("colocated next to source files");
		expect(prompt).toContain("describe/it blocks");
	});

	it("native worktree prompt omits project context when not provided", () => {
		const prompt = buildNativeWorktreePrompt(makeIssue());
		expect(prompt).not.toContain("## Project Context");
	});

	it("scoped prompt includes project context when provided", () => {
		const step: PlanStep = { repoPath: "/tmp/repo", scope: "add feature", order: 1 };
		const prompt = buildScopedImplementPrompt(
			makeIssue(),
			step,
			[],
			"vitest",
			"npm",
			false,
			"main",
			ctx,
		);
		expect(prompt).toContain("## Project Context");
		expect(prompt).toContain("### Quality Scripts");
	});

	it("scoped prompt omits project context when not provided", () => {
		const step: PlanStep = { repoPath: "/tmp/repo", scope: "add feature", order: 1 };
		const prompt = buildScopedImplementPrompt(makeIssue(), step, []);
		expect(prompt).not.toContain("## Project Context");
	});

	it("project context appears between description and instructions", () => {
		const prompt = buildImplementPrompt(
			makeIssue(),
			makeConfig({ workflow: "worktree" }),
			"vitest",
			"npm",
			ctx,
		);
		const descIndex = prompt.indexOf("Implement the feature X as described.");
		const ctxIndex = prompt.indexOf("## Project Context");
		const instrIndex = prompt.indexOf("## Instructions");
		expect(descIndex).toBeLessThan(ctxIndex);
		expect(ctxIndex).toBeLessThan(instrIndex);
	});
});

function makeDependency(overrides?: Partial<DependencyContext>): DependencyContext {
	return {
		issueId: "INT-99",
		branch: "feat/int-99-add-base-feature",
		prUrl: "https://github.com/org/repo/pull/42",
		changedFiles: ["src/types/index.ts", "src/utils.ts"],
		...overrides,
	};
}

describe("buildDependencyContext", () => {
	it("includes dependency issue ID and branch", () => {
		const ctx = buildDependencyContext(makeDependency());
		expect(ctx).toContain("INT-99");
		expect(ctx).toContain("feat/int-99-add-base-feature");
	});

	it("includes PR URL", () => {
		const ctx = buildDependencyContext(makeDependency());
		expect(ctx).toContain("https://github.com/org/repo/pull/42");
	});

	it("lists changed files", () => {
		const ctx = buildDependencyContext(makeDependency());
		expect(ctx).toContain("src/types/index.ts");
		expect(ctx).toContain("src/utils.ts");
	});

	it("instructs not to reimplement existing code", () => {
		const ctx = buildDependencyContext(makeDependency());
		expect(ctx).toContain("Do NOT reimplement");
	});

	it("instructs PR base to be dependency branch", () => {
		const ctx = buildDependencyContext(makeDependency());
		expect(ctx).toContain("must target `feat/int-99-add-base-feature` as its base branch");
	});

	it("handles empty changed files", () => {
		const ctx = buildDependencyContext(makeDependency({ changedFiles: [] }));
		expect(ctx).toContain("no files detected");
	});
});

describe("dependency context in prompts", () => {
	const dep = makeDependency();

	it("worktree prompt includes dependency context when issue has dependency", () => {
		const issue = makeIssue({ dependency: dep });
		const config = makeConfig({ workflow: "worktree" });
		const prompt = buildImplementPrompt(issue, config);

		expect(prompt).toContain("## Dependency Context");
		expect(prompt).toContain("INT-99");
		expect(prompt).toContain("feat/int-99-add-base-feature");
	});

	it("worktree prompt PR base uses dependency branch", () => {
		const issue = makeIssue({ dependency: dep });
		const config = makeConfig({ workflow: "worktree" });
		const prompt = buildImplementPrompt(issue, config);

		expect(prompt).toContain("--base feat/int-99-add-base-feature");
		expect(prompt).not.toContain("--base main");
	});

	it("worktree prompt omits dependency context when no dependency", () => {
		const prompt = buildImplementPrompt(makeIssue(), makeConfig({ workflow: "worktree" }));
		expect(prompt).not.toContain("## Dependency Context");
	});

	it("branch prompt includes dependency context when issue has dependency", () => {
		const issue = makeIssue({ dependency: dep });
		const config = makeConfig({ workflow: "branch" });
		const prompt = buildImplementPrompt(issue, config);

		expect(prompt).toContain("## Dependency Context");
		expect(prompt).toContain("INT-99");
	});

	it("branch prompt PR base uses dependency branch", () => {
		const issue = makeIssue({ dependency: dep });
		const config = makeConfig({ workflow: "branch" });
		const prompt = buildImplementPrompt(issue, config);

		expect(prompt).toContain("--base feat/int-99-add-base-feature");
	});

	it("branch prompt uses dependency branch for branch creation", () => {
		const issue = makeIssue({ dependency: dep });
		const config = makeConfig({ workflow: "branch" });
		const prompt = buildImplementPrompt(issue, config);

		expect(prompt).toContain("feat/int-99-add-base-feature");
		expect(prompt).toContain("dependency branch");
	});

	it("native worktree prompt includes dependency context", () => {
		const issue = makeIssue({ dependency: dep });
		const prompt = buildNativeWorktreePrompt(issue, "/repo", "vitest", "npm", "main");

		expect(prompt).toContain("## Dependency Context");
		expect(prompt).toContain("--base feat/int-99-add-base-feature");
	});

	it("native worktree prompt omits dependency context when no dependency", () => {
		const prompt = buildNativeWorktreePrompt(makeIssue(), "/repo", "vitest", "npm", "main");
		expect(prompt).not.toContain("## Dependency Context");
	});

	it("scoped prompt includes dependency context", () => {
		const issue = makeIssue({ dependency: dep });
		const step: PlanStep = { repoPath: "/tmp/repo", scope: "add feature", order: 1 };
		const prompt = buildScopedImplementPrompt(issue, step, []);

		expect(prompt).toContain("## Dependency Context");
		expect(prompt).toContain("--base feat/int-99-add-base-feature");
	});

	it("scoped prompt omits dependency context when no dependency", () => {
		const step: PlanStep = { repoPath: "/tmp/repo", scope: "add feature", order: 1 };
		const prompt = buildScopedImplementPrompt(makeIssue(), step, []);
		expect(prompt).not.toContain("## Dependency Context");
	});

	it("dependency context appears between description and instructions in worktree prompt", () => {
		const issue = makeIssue({ dependency: dep });
		const config = makeConfig({ workflow: "worktree" });
		const prompt = buildImplementPrompt(issue, config);

		const descIndex = prompt.indexOf("Implement the feature X as described.");
		const depIndex = prompt.indexOf("## Dependency Context");
		const instrIndex = prompt.indexOf("## Instructions");
		expect(descIndex).toBeLessThan(depIndex);
		expect(depIndex).toBeLessThan(instrIndex);
	});
});
