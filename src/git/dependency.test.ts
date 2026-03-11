import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	findOpenPr,
	getChangedFiles,
	resolveDependency,
	resolveFirstDependency,
} from "./dependency.js";

vi.mock("execa", () => ({
	execa: vi.fn(),
}));

vi.mock("./worktree.js", () => ({
	findBranchByIssueId: vi.fn(),
}));

describe("findOpenPr", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns PR info when an open PR exists for the branch", async () => {
		const { execa } = await import("execa");
		vi.mocked(execa).mockResolvedValueOnce({
			stdout: JSON.stringify([{ url: "https://github.com/org/repo/pull/42", state: "OPEN" }]),
		} as never);

		const result = await findOpenPr("feat/int-100-add-feature");

		expect(result).toEqual({ url: "https://github.com/org/repo/pull/42", state: "OPEN" });
		expect(vi.mocked(execa)).toHaveBeenCalledWith("gh", [
			"pr",
			"list",
			"--head",
			"feat/int-100-add-feature",
			"--state",
			"open",
			"--json",
			"url,state",
			"--limit",
			"1",
		]);
	});

	it("returns null when no open PR exists", async () => {
		const { execa } = await import("execa");
		vi.mocked(execa).mockResolvedValueOnce({ stdout: "[]" } as never);

		const result = await findOpenPr("feat/int-100-add-feature");

		expect(result).toBeNull();
	});

	it("returns null when gh CLI fails", async () => {
		const { execa } = await import("execa");
		vi.mocked(execa).mockRejectedValueOnce(new Error("gh not found"));

		const result = await findOpenPr("feat/int-100-add-feature");

		expect(result).toBeNull();
	});
});

describe("getChangedFiles", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns list of changed files between base and dependency branch", async () => {
		const { execa } = await import("execa");
		vi.mocked(execa)
			.mockResolvedValueOnce({ stdout: "" } as never) // fetch
			.mockResolvedValueOnce({
				stdout: "src/types/index.ts\nsrc/loop.ts\nsrc/prompt.ts",
			} as never); // diff

		const result = await getChangedFiles("/repo", "main", "feat/int-100-add-feature");

		expect(result).toEqual(["src/types/index.ts", "src/loop.ts", "src/prompt.ts"]);
	});

	it("returns empty array when diff fails", async () => {
		const { execa } = await import("execa");
		vi.mocked(execa)
			.mockResolvedValueOnce({ stdout: "" } as never) // fetch
			.mockRejectedValueOnce(new Error("diff failed")); // diff

		const result = await getChangedFiles("/repo", "main", "feat/int-100-add-feature");

		expect(result).toEqual([]);
	});

	it("filters out empty lines", async () => {
		const { execa } = await import("execa");
		vi.mocked(execa)
			.mockResolvedValueOnce({ stdout: "" } as never) // fetch
			.mockResolvedValueOnce({
				stdout: "src/file.ts\n\n  \nsrc/other.ts\n",
			} as never); // diff

		const result = await getChangedFiles("/repo", "main", "feat/int-100");

		expect(result).toEqual(["src/file.ts", "src/other.ts"]);
	});
});

describe("resolveDependency", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns full DependencyContext when blocker has branch with open PR", async () => {
		const { findBranchByIssueId } = await import("./worktree.js");
		const { execa } = await import("execa");

		vi.mocked(findBranchByIssueId).mockResolvedValueOnce("feat/int-100-add-feature");
		vi.mocked(execa)
			// findOpenPr: gh pr list
			.mockResolvedValueOnce({
				stdout: JSON.stringify([{ url: "https://github.com/org/repo/pull/42", state: "OPEN" }]),
			} as never)
			// getChangedFiles: git fetch
			.mockResolvedValueOnce({ stdout: "" } as never)
			// getChangedFiles: git diff
			.mockResolvedValueOnce({ stdout: "src/index.ts\nsrc/utils.ts" } as never);

		const result = await resolveDependency("/repo", "INT-100", "main");

		expect(result).toEqual({
			issueId: "INT-100",
			branch: "feat/int-100-add-feature",
			prUrl: "https://github.com/org/repo/pull/42",
			changedFiles: ["src/index.ts", "src/utils.ts"],
		});
	});

	it("returns null when blocker has no branch", async () => {
		const { findBranchByIssueId } = await import("./worktree.js");
		vi.mocked(findBranchByIssueId).mockResolvedValueOnce(undefined);

		const result = await resolveDependency("/repo", "INT-100", "main");

		expect(result).toBeNull();
	});

	it("returns null when blocker has branch but no open PR", async () => {
		const { findBranchByIssueId } = await import("./worktree.js");
		const { execa } = await import("execa");

		vi.mocked(findBranchByIssueId).mockResolvedValueOnce("feat/int-100-add-feature");
		vi.mocked(execa).mockResolvedValueOnce({ stdout: "[]" } as never); // no open PRs

		const result = await resolveDependency("/repo", "INT-100", "main");

		expect(result).toBeNull();
	});
});

describe("resolveFirstDependency", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns first resolved dependency from blocker list", async () => {
		const { findBranchByIssueId } = await import("./worktree.js");
		const { execa } = await import("execa");

		// First blocker has no branch
		vi.mocked(findBranchByIssueId)
			.mockResolvedValueOnce(undefined) // INT-99: no branch
			.mockResolvedValueOnce("feat/int-100-add-feature"); // INT-100: has branch

		vi.mocked(execa)
			// findOpenPr for INT-100
			.mockResolvedValueOnce({
				stdout: JSON.stringify([{ url: "https://github.com/org/repo/pull/42", state: "OPEN" }]),
			} as never)
			// getChangedFiles: fetch
			.mockResolvedValueOnce({ stdout: "" } as never)
			// getChangedFiles: diff
			.mockResolvedValueOnce({ stdout: "src/file.ts" } as never);

		const result = await resolveFirstDependency("/repo", ["INT-99", "INT-100"], "main");

		expect(result).toEqual({
			issueId: "INT-100",
			branch: "feat/int-100-add-feature",
			prUrl: "https://github.com/org/repo/pull/42",
			changedFiles: ["src/file.ts"],
		});
	});

	it("returns null when no blocker has an open PR", async () => {
		const { findBranchByIssueId } = await import("./worktree.js");
		vi.mocked(findBranchByIssueId).mockResolvedValue(undefined);

		const result = await resolveFirstDependency("/repo", ["INT-99", "INT-100"], "main");

		expect(result).toBeNull();
	});

	it("returns null for empty blocker list", async () => {
		const result = await resolveFirstDependency("/repo", [], "main");

		expect(result).toBeNull();
	});
});
