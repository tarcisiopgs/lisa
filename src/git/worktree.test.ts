import { existsSync, rmSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	cleanupOrphanedWorktree,
	createWorktree,
	determineRepoPath,
	generateBranchName,
	hasCodeChanges,
} from "./worktree.js";

vi.mock("execa", () => ({
	execa: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		existsSync: vi.fn(),
		readFileSync: vi.fn(),
		appendFileSync: vi.fn(),
		rmSync: vi.fn(),
	};
});

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

describe("createWorktree", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("removes residual directory when it exists on disk after orphan cleanup", async () => {
		const { execa } = await import("execa");
		const branch = "feat/int-1-fix";
		const worktreePath = "/repo/.worktrees/feat/int-1-fix";

		// cleanupOrphanedWorktree: branch does not exist → returns false
		vi.mocked(execa).mockResolvedValueOnce({ stdout: "" } as never);

		// existsSync returns true → residual directory exists
		vi.mocked(existsSync).mockReturnValueOnce(true);

		// git worktree remove --force (reject: false)
		vi.mocked(execa).mockResolvedValueOnce({ stdout: "" } as never);
		// git worktree prune (reject: false)
		vi.mocked(execa).mockResolvedValueOnce({ stdout: "" } as never);

		// existsSync again → directory was removed by git
		vi.mocked(existsSync).mockReturnValueOnce(false);

		// git fetch origin main
		vi.mocked(execa).mockResolvedValueOnce({ stdout: "" } as never);
		// git worktree add
		vi.mocked(execa).mockResolvedValueOnce({ stdout: "" } as never);

		const result = await createWorktree("/repo", branch, "main");

		expect(result).toBe(worktreePath);
		expect(vi.mocked(execa)).toHaveBeenCalledWith(
			"git",
			["worktree", "remove", worktreePath, "--force"],
			{ cwd: "/repo", reject: false },
		);
		expect(vi.mocked(rmSync)).not.toHaveBeenCalled();
	});

	it("falls back to rmSync when git worktree remove does not clear the directory", async () => {
		const { execa } = await import("execa");
		const branch = "feat/int-2-bug";
		const worktreePath = "/repo/.worktrees/feat/int-2-bug";

		// cleanupOrphanedWorktree: branch does not exist
		vi.mocked(execa).mockResolvedValueOnce({ stdout: "" } as never);

		// existsSync: directory exists
		vi.mocked(existsSync).mockReturnValueOnce(true);

		// git worktree remove --force
		vi.mocked(execa).mockResolvedValueOnce({ stdout: "" } as never);
		// git worktree prune
		vi.mocked(execa).mockResolvedValueOnce({ stdout: "" } as never);

		// existsSync: directory still exists after git commands
		vi.mocked(existsSync).mockReturnValueOnce(true);

		// git fetch origin main
		vi.mocked(execa).mockResolvedValueOnce({ stdout: "" } as never);
		// git worktree add
		vi.mocked(execa).mockResolvedValueOnce({ stdout: "" } as never);

		const result = await createWorktree("/repo", branch, "main");

		expect(result).toBe(worktreePath);
		expect(vi.mocked(rmSync)).toHaveBeenCalledWith(worktreePath, {
			recursive: true,
			force: true,
		});
	});

	it("skips residual cleanup when directory does not exist", async () => {
		const { execa } = await import("execa");
		const branch = "feat/int-3-clean";

		// cleanupOrphanedWorktree: branch does not exist
		vi.mocked(execa).mockResolvedValueOnce({ stdout: "" } as never);

		// existsSync: no residual directory
		vi.mocked(existsSync).mockReturnValueOnce(false);

		// git fetch origin main
		vi.mocked(execa).mockResolvedValueOnce({ stdout: "" } as never);
		// git worktree add
		vi.mocked(execa).mockResolvedValueOnce({ stdout: "" } as never);

		await createWorktree("/repo", branch, "main");

		// Should not attempt worktree remove or rmSync
		expect(vi.mocked(execa)).not.toHaveBeenCalledWith(
			"git",
			expect.arrayContaining(["worktree", "remove"]),
			expect.objectContaining({ reject: false }),
		);
		expect(vi.mocked(rmSync)).not.toHaveBeenCalled();
	});
});

describe("hasCodeChanges", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns true when there are code changes", async () => {
		const { execa } = await import("execa");
		vi.mocked(execa).mockResolvedValueOnce({
			stdout: " file1.ts | 10 ++---\n file2.ts | 5 +++\n",
		} as never);

		const result = await hasCodeChanges("/repo", "main");

		expect(result).toBe(true);
		expect(vi.mocked(execa)).toHaveBeenCalledWith("git", ["diff", "--stat", "main..HEAD"], {
			cwd: "/repo",
			reject: false,
		});
	});

	it("returns false when there are no code changes", async () => {
		const { execa } = await import("execa");
		vi.mocked(execa).mockResolvedValueOnce({ stdout: "" } as never);

		const result = await hasCodeChanges("/repo", "main");

		expect(result).toBe(false);
	});

	it("returns false when git command fails", async () => {
		const { execa } = await import("execa");
		vi.mocked(execa).mockRejectedValueOnce(new Error("git error") as never);

		const result = await hasCodeChanges("/repo", "main");

		expect(result).toBe(false);
	});

	it("returns true when diff output is only whitespace", async () => {
		const { execa } = await import("execa");
		vi.mocked(execa).mockResolvedValueOnce({ stdout: "   " } as never);

		const result = await hasCodeChanges("/repo", "main");

		expect(result).toBe(false);
	});
});
