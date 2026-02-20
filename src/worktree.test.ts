import { describe, expect, it } from "vitest";
import { determineRepoPath, generateBranchName } from "./worktree.js";

describe("generateBranchName", () => {
	it("generates a branch name from issue ID and title", () => {
		const branch = generateBranchName("INT-100", "Add feature X");
		expect(branch).toBe("feat/int-100-add-feature-x");
	});

	it("lowercases the issue ID", () => {
		const branch = generateBranchName("INT-200", "Some Title");
		expect(branch).toMatch(/^feat\/int-200-/);
	});

	it("converts special characters to hyphens", () => {
		const branch = generateBranchName("INT-1", "Fix: special chars & more!");
		expect(branch).toBe("feat/int-1-fix-special-chars-more");
	});

	it("truncates long titles to 40 characters", () => {
		const longTitle =
			"This is a very long title that should be truncated because it exceeds the maximum length";
		const branch = generateBranchName("INT-1", longTitle);
		const slug = branch.replace("feat/int-1-", "");
		expect(slug.length).toBeLessThanOrEqual(40);
	});

	it("strips leading and trailing hyphens from slug", () => {
		const branch = generateBranchName("INT-1", "---clean me---");
		expect(branch).toBe("feat/int-1-clean-me");
	});
});

describe("determineRepoPath", () => {
	const repos = [
		{ name: "app", path: "./app", match: "App:" },
		{ name: "api", path: "./api", match: "API:" },
	];
	const workspace = "/workspace";

	it("returns undefined when repos array is empty", () => {
		const result = determineRepoPath([], { title: "Something" }, workspace);
		expect(result).toBeUndefined();
	});

	it("matches by issue repo field", () => {
		const result = determineRepoPath(repos, { repo: "api", title: "Something" }, workspace);
		expect(result).toBe("/workspace/api");
	});

	it("matches by title prefix", () => {
		const result = determineRepoPath(repos, { title: "App: fix bug" }, workspace);
		expect(result).toBe("/workspace/app");
	});

	it("matches second repo by title prefix", () => {
		const result = determineRepoPath(repos, { title: "API: add endpoint" }, workspace);
		expect(result).toBe("/workspace/api");
	});

	it("defaults to first repo when no match", () => {
		const result = determineRepoPath(repos, { title: "No match here" }, workspace);
		expect(result).toBe("/workspace/app");
	});

	it("prefers repo field over title prefix", () => {
		const result = determineRepoPath(repos, { repo: "api", title: "App: misleading" }, workspace);
		expect(result).toBe("/workspace/api");
	});
});
