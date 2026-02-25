import { execa } from "execa";
import type { DependencyContext } from "../types/index.js";
import { findBranchByIssueId } from "./worktree.js";

/**
 * Resolves a dependency context for a completed blocker issue.
 * Checks if the blocker has a branch with an open (unmerged) PR.
 * If so, returns the full DependencyContext; otherwise returns null.
 */
export async function resolveDependency(
	repoPath: string,
	blockerIssueId: string,
	baseBranch: string,
): Promise<DependencyContext | null> {
	// 1. Find the blocker's branch
	const branch = await findBranchByIssueId(repoPath, blockerIssueId);
	if (!branch) return null;

	// 2. Check if there's an open PR for that branch
	const prInfo = await findOpenPr(branch);
	if (!prInfo) return null;

	// 3. Get changed files between base branch and dependency branch
	const changedFiles = await getChangedFiles(repoPath, baseBranch, branch);

	return {
		issueId: blockerIssueId,
		branch,
		prUrl: prInfo.url,
		changedFiles,
	};
}

/**
 * Resolves the first valid dependency from a list of completed blocker IDs.
 * Returns the first blocker that has an open PR, or null if none do.
 */
export async function resolveFirstDependency(
	repoPath: string,
	blockerIds: string[],
	baseBranch: string,
): Promise<DependencyContext | null> {
	for (const blockerId of blockerIds) {
		const dep = await resolveDependency(repoPath, blockerId, baseBranch);
		if (dep) return dep;
	}
	return null;
}

interface PrInfo {
	url: string;
	state: string;
}

/**
 * Finds an open (not merged) PR for the given branch using gh CLI.
 */
export async function findOpenPr(branch: string): Promise<PrInfo | null> {
	try {
		const { stdout } = await execa("gh", [
			"pr",
			"list",
			"--head",
			branch,
			"--state",
			"open",
			"--json",
			"url,state",
			"--limit",
			"1",
		]);

		const prs = JSON.parse(stdout) as PrInfo[];
		if (prs.length === 0) return null;

		return prs[0] ?? null;
	} catch {
		return null;
	}
}

/**
 * Gets the list of changed files between the base branch and the dependency branch.
 */
export async function getChangedFiles(
	repoPath: string,
	baseBranch: string,
	dependencyBranch: string,
): Promise<string[]> {
	try {
		// Fetch both branches to ensure we have latest refs
		await execa("git", ["fetch", "origin", dependencyBranch], {
			cwd: repoPath,
			reject: false,
		});

		const { stdout } = await execa(
			"git",
			["diff", "--name-only", `origin/${baseBranch}...origin/${dependencyBranch}`],
			{ cwd: repoPath },
		);

		return stdout
			.split("\n")
			.map((f) => f.trim())
			.filter(Boolean);
	} catch {
		return [];
	}
}
