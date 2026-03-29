import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";

const WORKTREES_DIR = ".worktrees";

export function generateBranchName(issueId: string, title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.substring(0, 40)
		.replace(/^-|-$/g, "");

	const safeId = issueId.toLowerCase().replace(/[^a-z0-9-]/g, "-");
	let branch = `feat/${safeId}-${slug}`;

	// Sanitize: remove path traversal sequences and invalid git ref patterns
	branch = branch.replace(/\.\./g, "");
	branch = branch.replace(/@\{/g, "");
	branch = branch.replace(/^[./]+/, "").replace(/[./]+$/, "");

	// Fallback if sanitization left an empty or prefix-only name
	if (!branch || branch === "feat/" || branch === "feat") {
		branch = `feat/${safeId}-${Date.now()}`;
	}

	return branch;
}

/**
 * Removes an orphaned worktree and its associated local branch, if they exist.
 * Returns true if cleanup was performed, false if there was nothing to clean up.
 */
export async function cleanupOrphanedWorktree(
	repoRoot: string,
	branchName: string,
): Promise<boolean> {
	// Check if branch exists locally
	const { stdout: branchList } = await execa("git", ["branch", "--list", branchName], {
		cwd: repoRoot,
		reject: false,
	});

	if (!branchList.trim()) {
		return false;
	}

	// Check if there is an associated worktree and remove it
	const worktreePath = join(repoRoot, WORKTREES_DIR, branchName);
	const { stdout: worktreeList } = await execa("git", ["worktree", "list", "--porcelain"], {
		cwd: repoRoot,
		reject: false,
	});

	if (worktreeList.includes(worktreePath)) {
		await execa("git", ["worktree", "remove", worktreePath, "--force"], { cwd: repoRoot });
		await execa("git", ["worktree", "prune"], { cwd: repoRoot });
	}

	// Delete the local branch
	await execa("git", ["branch", "-D", branchName], { cwd: repoRoot });

	return true;
}

export async function createWorktree(
	repoRoot: string,
	branchName: string,
	baseBranch: string,
): Promise<string> {
	const worktreePath = join(repoRoot, WORKTREES_DIR, branchName);

	// Remove any orphaned worktree/branch before creating a fresh one
	await cleanupOrphanedWorktree(repoRoot, branchName);

	// Ensure worktree directory doesn't exist on disk (may be left from a crashed run)
	if (existsSync(worktreePath)) {
		await execa("git", ["worktree", "remove", worktreePath, "--force"], {
			cwd: repoRoot,
			reject: false,
		});
		await execa("git", ["worktree", "prune"], { cwd: repoRoot, reject: false });
		if (existsSync(worktreePath)) {
			rmSync(worktreePath, { recursive: true, force: true });
		}
	}

	await execa("git", ["fetch", "origin", baseBranch], { cwd: repoRoot });
	await execa("git", ["worktree", "add", "-b", branchName, worktreePath, `origin/${baseBranch}`], {
		cwd: repoRoot,
	});

	return worktreePath;
}

export async function removeWorktree(repoRoot: string, worktreePath: string): Promise<void> {
	await execa("git", ["worktree", "remove", worktreePath, "--force"], {
		cwd: repoRoot,
	});
	await execa("git", ["worktree", "prune"], { cwd: repoRoot });
}

export function ensureWorktreeGitignore(repoRoot: string): void {
	const gitignorePath = join(repoRoot, ".gitignore");

	if (!existsSync(gitignorePath)) {
		appendFileSync(gitignorePath, `${WORKTREES_DIR}\n`);
		return;
	}

	const content = readFileSync(gitignorePath, "utf-8");
	if (!content.split("\n").some((line) => line.trim() === WORKTREES_DIR)) {
		const separator = content.endsWith("\n") ? "" : "\n";
		appendFileSync(gitignorePath, `${separator}${WORKTREES_DIR}\n`);
	}
}

export async function findBranchByIssueId(
	repoRoot: string,
	issueId: string,
): Promise<string | undefined> {
	const needle = issueId.toLowerCase();

	// Check local branches first
	const { stdout: local } = await execa(
		"git",
		["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads/"],
		{ cwd: repoRoot },
	);

	const localMatch = local
		.split("\n")
		.map((b) => b.trim())
		.filter(Boolean)
		.find((b) => b.toLowerCase().includes(needle));
	if (localMatch) return localMatch;

	// Check local remote-tracking refs
	const { stdout: remote } = await execa(
		"git",
		["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/remotes/origin/"],
		{ cwd: repoRoot },
	);

	const remoteMatch = remote
		.split("\n")
		.map((b) => b.trim())
		.filter(Boolean)
		.find((b) => b.toLowerCase().includes(needle));
	if (remoteMatch) return remoteMatch.replace("origin/", "");

	// Fall back to querying the actual remote (local refs may be stale)
	const { stdout: lsRemote } = await execa("git", ["ls-remote", "--heads", "origin"], {
		cwd: repoRoot,
	});

	const lsMatch = lsRemote
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.map((l) => l.split("\t")[1]?.replace("refs/heads/", "") ?? "")
		.find((b) => b.toLowerCase().includes(needle));
	if (lsMatch) return lsMatch;

	return undefined;
}

export function determineRepoPath(
	repos: { name: string; path: string; match: string }[],
	issue: { repo?: string; title: string },
	workspace: string,
): string | undefined {
	if (repos.length === 0) return undefined;

	// Try matching by repo field
	if (issue.repo) {
		const match = repos.find((r) => r.name === issue.repo);
		if (match) return join(workspace, match.path);
	}

	// Try matching by title prefix
	for (const r of repos) {
		if (r.match && issue.title.startsWith(r.match)) {
			return join(workspace, r.path);
		}
	}

	// Default to first repo
	const first = repos[0];
	return first ? join(workspace, first.path) : undefined;
}

/**
 * Checks if there are actual code changes between the base branch and HEAD.
 * Returns true if there are changes, false if the diff is empty.
 */
export async function hasCodeChanges(repoPath: string, baseBranch: string): Promise<boolean> {
	try {
		const { stdout } = await execa("git", ["diff", "--stat", `${baseBranch}..HEAD`], {
			cwd: repoPath,
			reject: false,
		});
		const trimmed = stdout.trim();
		return trimmed.length > 0;
	} catch {
		return false;
	}
}

export async function getDiffStat(repoPath: string, baseBranch: string): Promise<string> {
	try {
		const { stdout } = await execa("git", ["diff", "--stat", `${baseBranch}..HEAD`], {
			cwd: repoPath,
			reject: false,
		});
		return stdout.trim();
	} catch {
		return "";
	}
}
