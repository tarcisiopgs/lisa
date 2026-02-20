import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildImplementPrompt, buildWorktreeMultiRepoPrompt, detectTestRunner } from "./prompt.js";
import type { Issue, LisaConfig } from "./types.js";

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
	});

	describe("worktree mode — multi-repo", () => {
		const multiRepoConfig = makeConfig({
			workflow: "worktree",
			workspace: "/tmp/workspace",
			repos: [
				{ name: "api", path: "./api", match: "API:", base_branch: "main" },
				{ name: "admin", path: "./admin", match: "Admin:", base_branch: "main" },
			],
		});

		it("includes the pre-generated branch name", () => {
			const prompt = buildWorktreeMultiRepoPrompt(
				makeIssue(),
				multiRepoConfig,
				"feat/int-100-my-branch",
			);
			expect(prompt).toContain("feat/int-100-my-branch");
		});

		it("lists all repo absolute paths", () => {
			const prompt = buildWorktreeMultiRepoPrompt(makeIssue(), multiRepoConfig, "feat/int-100-x");
			expect(prompt).toContain("/tmp/workspace/api");
			expect(prompt).toContain("/tmp/workspace/admin");
		});

		it("lists the worktree path for each repo", () => {
			const prompt = buildWorktreeMultiRepoPrompt(makeIssue(), multiRepoConfig, "feat/int-100-x");
			expect(prompt).toContain("/tmp/workspace/api/.worktrees/feat/int-100-x");
			expect(prompt).toContain("/tmp/workspace/admin/.worktrees/feat/int-100-x");
		});

		it("includes the manifest file path", () => {
			const prompt = buildWorktreeMultiRepoPrompt(makeIssue(), multiRepoConfig, "feat/int-100-x");
			expect(prompt).toContain(".lisa-manifest.json");
			expect(prompt).toContain("/tmp/workspace/.lisa-manifest.json");
		});

		it("instructs agent NOT to push", () => {
			const prompt = buildWorktreeMultiRepoPrompt(makeIssue(), multiRepoConfig, "feat/int-100-x");
			expect(prompt).toContain("do NOT push");
			expect(prompt).toContain("Do NOT push");
		});

		it("includes issue details", () => {
			const prompt = buildWorktreeMultiRepoPrompt(makeIssue(), multiRepoConfig, "feat/int-100-x");
			expect(prompt).toContain("INT-100");
			expect(prompt).toContain("Add feature X");
			expect(prompt).toContain("Implement the feature X as described.");
		});

		it("includes README evaluation instructions", () => {
			const prompt = buildWorktreeMultiRepoPrompt(makeIssue(), multiRepoConfig, "feat/int-100-x");
			expect(prompt).toContain("README.md Evaluation");
		});

		it("includes the workspace root path", () => {
			const prompt = buildWorktreeMultiRepoPrompt(makeIssue(), multiRepoConfig, "feat/int-100-x");
			expect(prompt).toContain("/tmp/workspace");
		});
	});

	describe("branch mode", () => {
		it("includes branch-specific instructions", () => {
			const prompt = buildImplementPrompt(makeIssue(), makeConfig({ workflow: "branch" }));

			expect(prompt).toContain("Create a branch");
			expect(prompt).toContain("feat/int-100-short-description");
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
	});
});
