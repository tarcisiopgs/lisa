import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildImplementPrompt,
	buildNativeWorktreePrompt,
	buildPlanningPrompt,
	buildScopedImplementPrompt,
	detectTestRunner,
} from "./prompt.js";
import type { Issue, LisaConfig, PlanStep } from "./types.js";

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
		github: "cli",
		workflow: "worktree",
		workspace: "/tmp/workspace",
		base_branch: "main",
		repos: [],
		loop: { cooldown: 0, max_sessions: 0 },
		logs: { dir: "/tmp/logs", format: "text" },
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

		it("includes README evaluation instructions", () => {
			const prompt = buildImplementPrompt(makeIssue(), makeConfig({ workflow: "worktree" }));

			expect(prompt).toContain("README.md Evaluation");
			expect(prompt).toContain("New or removed CLI commands or flags");
			expect(prompt).toContain("New or removed providers or sources");
			expect(prompt).toContain("Configuration schema changes");
			expect(prompt).toContain("Do NOT update README.md for");
			expect(prompt).toContain("Internal refactors that don't change documented behavior");
		});

		it("includes concrete prBody markdown template with example structure", () => {
			const prompt = buildImplementPrompt(makeIssue(), makeConfig({ workflow: "worktree" }));
			expect(prompt).toContain("**What**:");
			expect(prompt).toContain("**Why**:");
			expect(prompt).toContain("**Key changes**:");
			expect(prompt).toContain("**Testing**:");
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

		it("includes README evaluation instructions", () => {
			const prompt = buildImplementPrompt(makeIssue(), makeConfig({ workflow: "branch" }));

			expect(prompt).toContain("README.md Evaluation");
			expect(prompt).toContain("New or removed CLI commands or flags");
			expect(prompt).toContain("New or removed providers or sources");
			expect(prompt).toContain("Configuration schema changes");
			expect(prompt).toContain("Do NOT update README.md for");
			expect(prompt).toContain("Internal refactors that don't change documented behavior");
		});

		it("includes concrete prBody markdown template with example structure", () => {
			const prompt = buildImplementPrompt(makeIssue(), makeConfig({ workflow: "branch" }));
			expect(prompt).toContain("**What**:");
			expect(prompt).toContain("**Why**:");
			expect(prompt).toContain("**Key changes**:");
			expect(prompt).toContain("**Testing**:");
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

	it("instructs agent not to push", () => {
		const prompt = buildNativeWorktreePrompt(makeIssue());
		expect(prompt).toContain("Do NOT push");
	});

	it("includes manifest instructions", () => {
		const prompt = buildNativeWorktreePrompt(makeIssue());
		expect(prompt).toContain(".lisa-manifest.json");
	});

	it("writes manifest to repoPath when provided", () => {
		const prompt = buildNativeWorktreePrompt(makeIssue(), "/tmp/my-repo");
		expect(prompt).toContain("/tmp/my-repo/.lisa-manifest.json");
	});

	it("writes manifest to current directory when repoPath not provided", () => {
		const prompt = buildNativeWorktreePrompt(makeIssue());
		expect(prompt).toContain("in the **current directory**");
	});

	it("includes prBody template", () => {
		const prompt = buildNativeWorktreePrompt(makeIssue());
		expect(prompt).toContain("**What**:");
		expect(prompt).toContain("**Why**:");
		expect(prompt).toContain("**Key changes**:");
		expect(prompt).toContain("**Testing**:");
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

	it("includes README evaluation instructions", () => {
		const prompt = buildNativeWorktreePrompt(makeIssue());
		expect(prompt).toContain("README.md Evaluation");
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

	it("mentions .lisa-plan.json", () => {
		const prompt = buildPlanningPrompt(makeIssue(), multiRepoConfig);
		expect(prompt).toContain(".lisa-plan.json");
	});

	it("describes JSON structure with steps", () => {
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

	it("includes prBody template", () => {
		const prompt = buildScopedImplementPrompt(makeIssue(), step, []);
		expect(prompt).toContain("**What**:");
		expect(prompt).toContain("**Why**:");
		expect(prompt).toContain("**Key changes**:");
		expect(prompt).toContain("**Testing**:");
	});

	it("instructs agent not to push", () => {
		const prompt = buildScopedImplementPrompt(makeIssue(), step, []);
		expect(prompt).toContain("Do NOT push");
	});

	it("includes test instructions when provided", () => {
		const prompt = buildScopedImplementPrompt(makeIssue(), step, [], "vitest");
		expect(prompt).toContain("MANDATORY — Unit Tests");
		expect(prompt).toContain("vitest");
	});
});
