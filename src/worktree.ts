import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execa } from "execa";

const WORKTREES_DIR = ".worktrees";

export async function getDefaultBranch(repoRoot: string): Promise<string> {
	const { stdout } = await execa("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"], {
		cwd: repoRoot,
		reject: false,
	}).then(
		(r) => r,
		() => ({ stdout: "origin/main" }),
	);

	return stdout.replace("origin/", "").trim();
}

export function generateBranchName(issueId: string, title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.substring(0, 40);

	return `feat/${issueId.toLowerCase()}-${slug}`;
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
 * Scan all repos in the workspace to find where feature branches were created.
 * Returns ALL repos that have a matching feature branch — the agent may work
 * across multiple repos in a single session.
 *
 * Detection per repo (in priority order):
 * 1. Current branch contains the issue ID (strongest signal)
 * 2. Current branch differs from the repo's base branch (agent is still on it)
 * 3. Any local/remote branch contains the issue ID (agent switched back)
 */
export async function detectFeatureBranches(
	repos: { path: string; base_branch: string }[],
	issueId: string,
	workspace: string,
	globalBaseBranch: string,
): Promise<{ repoPath: string; branch: string }[]> {
	const entries =
		repos.length > 0
			? repos.map((r) => ({ path: resolve(workspace, r.path), baseBranch: r.base_branch }))
			: [{ path: workspace, baseBranch: globalBaseBranch }];

	const needle = issueId.toLowerCase();
	const results: { repoPath: string; branch: string }[] = [];
	const matched = new Set<string>();

	// Pass 1: current branch contains the issue ID (strongest signal)
	const currentBranches: { path: string; baseBranch: string; current: string }[] = [];
	for (const entry of entries) {
		try {
			const { stdout } = await execa("git", ["branch", "--show-current"], { cwd: entry.path });
			const current = stdout.trim();
			currentBranches.push({ ...entry, current });
			if (current?.toLowerCase().includes(needle)) {
				results.push({ repoPath: entry.path, branch: current });
				matched.add(entry.path);
			}
		} catch {
			// Not a git repo or other error — skip
		}
	}

	// Pass 2: current branch differs from base branch (agent stayed on feature branch)
	for (const entry of currentBranches) {
		if (!matched.has(entry.path) && entry.current && entry.current !== entry.baseBranch) {
			results.push({ repoPath: entry.path, branch: entry.current });
			matched.add(entry.path);
		}
	}

	// Pass 3: search for any branch containing the issue ID (agent may have switched back)
	for (const entry of entries) {
		if (matched.has(entry.path)) continue;
		const branch = await findBranchByIssueId(entry.path, issueId);
		if (branch) {
			results.push({ repoPath: entry.path, branch });
		}
	}

	return results;
}
