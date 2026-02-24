import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupOrphanedWorktree, determineRepoPath, generateBranchName } from "./worktree.js";

vi.mock("execa", () => ({
	execa: vi.fn(),
}));

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

	it("never produces a trailing dash after truncation", () => {
		// Title whose slug is exactly 40 chars ending with a dash before trim
		const branch = generateBranchName(
			"INT-193",
			"Exibir alerta no dashboard para pedidos com status desatualizado",
		);
		expect(branch).not.toMatch(/-$/);
		expect(branch).not.toMatch(/--/);
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

describe("cleanupOrphanedWorktree", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns false when branch does not exist", async () => {
		const { execa } = await import("execa");
		vi.mocked(execa).mockResolvedValueOnce({ stdout: "" } as never);

		const result = await cleanupOrphanedWorktree("/repo", "feat/int-1-fix");

		expect(result).toBe(false);
		expect(vi.mocked(execa)).toHaveBeenCalledWith("git", ["branch", "--list", "feat/int-1-fix"], {
			cwd: "/repo",
			reject: false,
		});
	});

	it("removes worktree and branch when both exist", async () => {
		const { execa } = await import("execa");
		const worktreePath = "/repo/.worktrees/feat/int-1-fix";
		vi.mocked(execa)
			.mockResolvedValueOnce({ stdout: "  feat/int-1-fix" } as never) // branch --list
			.mockResolvedValueOnce({ stdout: `worktree ${worktreePath}\n` } as never) // worktree list
			.mockResolvedValueOnce({ stdout: "" } as never) // worktree remove
			.mockResolvedValueOnce({ stdout: "" } as never) // worktree prune
			.mockResolvedValueOnce({ stdout: "" } as never); // branch -D

		const result = await cleanupOrphanedWorktree("/repo", "feat/int-1-fix");

		expect(result).toBe(true);
		expect(vi.mocked(execa)).toHaveBeenCalledWith(
			"git",
			["worktree", "remove", worktreePath, "--force"],
			{ cwd: "/repo" },
		);
		expect(vi.mocked(execa)).toHaveBeenCalledWith("git", ["worktree", "prune"], { cwd: "/repo" });
		expect(vi.mocked(execa)).toHaveBeenCalledWith("git", ["branch", "-D", "feat/int-1-fix"], {
			cwd: "/repo",
		});
	});

	it("deletes only branch when no associated worktree exists", async () => {
		const { execa } = await import("execa");
		vi.mocked(execa)
			.mockResolvedValueOnce({ stdout: "  feat/int-1-fix" } as never) // branch --list
			.mockResolvedValueOnce({ stdout: "worktree /repo/.worktrees/feat/other\n" } as never) // worktree list (no match)
			.mockResolvedValueOnce({ stdout: "" } as never); // branch -D

		const result = await cleanupOrphanedWorktree("/repo", "feat/int-1-fix");

		expect(result).toBe(true);
		expect(vi.mocked(execa)).not.toHaveBeenCalledWith(
			"git",
			expect.arrayContaining(["worktree", "remove"]),
			expect.anything(),
		);
		expect(vi.mocked(execa)).toHaveBeenCalledWith("git", ["branch", "-D", "feat/int-1-fix"], {
			cwd: "/repo",
		});
	});
});
