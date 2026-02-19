import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";

const WORKTREES_DIR = ".worktrees";

export async function getDefaultBranch(repoRoot: string): Promise<string> {
	const { stdout } = await execa(
		"git",
		["symbolic-ref", "refs/remotes/origin/HEAD", "--short"],
		{ cwd: repoRoot, reject: false },
	).then(
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

export async function createWorktree(
	repoRoot: string,
	branchName: string,
	baseBranch: string,
): Promise<string> {
	const worktreePath = join(repoRoot, WORKTREES_DIR, branchName);

	await execa("git", ["fetch", "origin", baseBranch], { cwd: repoRoot });
	await execa(
		"git",
		["worktree", "add", "-b", branchName, worktreePath, `origin/${baseBranch}`],
		{ cwd: repoRoot },
	);

	return worktreePath;
}

export async function removeWorktree(
	repoRoot: string,
	worktreePath: string,
): Promise<void> {
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

export async function findBranchByIssueId(repoRoot: string, issueId: string): Promise<string | undefined> {
	const needle = issueId.toLowerCase();

	// Check local branches first
	const { stdout: local } = await execa("git", [
		"for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads/",
	], { cwd: repoRoot });

	const localMatch = local.split("\n").map((b) => b.trim()).filter(Boolean)
		.find((b) => b.toLowerCase().includes(needle));
	if (localMatch) return localMatch;

	// Check local remote-tracking refs
	const { stdout: remote } = await execa("git", [
		"for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/remotes/origin/",
	], { cwd: repoRoot });

	const remoteMatch = remote.split("\n").map((b) => b.trim()).filter(Boolean)
		.find((b) => b.toLowerCase().includes(needle));
	if (remoteMatch) return remoteMatch.replace("origin/", "");

	// Fall back to querying the actual remote (local refs may be stale)
	const { stdout: lsRemote } = await execa("git", [
		"ls-remote", "--heads", "origin",
	], { cwd: repoRoot });

	const lsMatch = lsRemote.split("\n").map((l) => l.trim()).filter(Boolean)
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
	return join(workspace, repos[0]!.path);
}
