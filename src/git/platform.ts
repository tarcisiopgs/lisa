import { formatError } from "../errors.js";
import { warn } from "../output/logger.js";
import { formatProofOfWork } from "../session/proof-of-work.js";
import { formatSpecCompliance } from "../session/spec-compliance.js";
import type {
	PRPlatform,
	PrConfig,
	SpecComplianceResult,
	ValidationResult,
} from "../types/index.js";
import {
	addPrReviewers as addBitbucketReviewers,
	appendPrAttribution as appendBitbucketAttribution,
	appendPrBody as appendBitbucketBody,
	listWorkspaceMembers as listBitbucketMembers,
	removePrReviewers as removeBitbucketReviewers,
} from "./bitbucket.js";
import {
	addAssignees as addGitHubAssignees,
	addReviewers as addGitHubReviewers,
	appendPrAttribution as appendGitHubAttribution,
	appendPrBody as appendGitHubBody,
	getAuthenticatedUser as getGitHubAuthenticatedUser,
	listCollaborators as listGitHubCollaborators,
	removeReviewers as removeGitHubReviewers,
} from "./github.js";
import {
	addMrReviewersAndAssignees,
	appendMrAttribution as appendGitLabAttribution,
	appendMrBody as appendGitLabBody,
	getGitLabAuthenticatedUser,
	listProjectMembers as listGitLabMembers,
	removeMrReviewers as removeGitLabReviewers,
} from "./gitlab.js";

/**
 * Routes PR/MR attribution to the correct platform implementation.
 * Non-fatal — all errors are swallowed internally by each platform.
 */
export async function appendPlatformAttribution(
	prUrl: string,
	providerUsed: string,
	platform: PRPlatform,
): Promise<void> {
	if (platform === "gitlab") {
		await appendGitLabAttribution(prUrl, providerUsed);
	} else if (platform === "bitbucket") {
		await appendBitbucketAttribution(prUrl, providerUsed);
	} else {
		// "cli" or "token" — both use GitHub
		await appendGitHubAttribution(prUrl, providerUsed);
	}
}

/**
 * Appends proof-of-work validation results to the PR/MR body.
 * Non-fatal — all errors are swallowed internally by each platform.
 */
export async function appendPlatformProofOfWork(
	prUrl: string,
	results: ValidationResult[],
	platform: PRPlatform,
): Promise<void> {
	const section = formatProofOfWork(results);
	try {
		if (platform === "gitlab") {
			await appendGitLabBody(prUrl, section);
		} else if (platform === "bitbucket") {
			await appendBitbucketBody(prUrl, section);
		} else {
			await appendGitHubBody(prUrl, section);
		}
	} catch {
		// Non-fatal — proof of work append is best-effort
	}
}

/**
 * Appends spec compliance results to the PR/MR body.
 * Non-fatal — all errors are swallowed internally by each platform.
 */
export async function appendPlatformSpecCompliance(
	prUrl: string,
	result: SpecComplianceResult,
	platform: PRPlatform,
): Promise<void> {
	const section = formatSpecCompliance(result);
	try {
		if (platform === "gitlab") {
			await appendGitLabBody(prUrl, section);
		} else if (platform === "bitbucket") {
			await appendBitbucketBody(prUrl, section);
		} else {
			await appendGitHubBody(prUrl, section);
		}
	} catch {
		// Non-fatal — spec compliance append is best-effort
	}
}

/**
 * Builds the "Create PR/MR" instruction block for agent prompts based on platform.
 * Returns the content only (without a step number prefix).
 */
export function buildPrCreateInstruction(
	platform: PRPlatform,
	targetBranch: string | undefined,
): string {
	const base = targetBranch ? ` --base ${targetBranch}` : "";

	if (platform === "gitlab") {
		const branchArg = targetBranch ? ` --target-branch ${targetBranch}` : "";
		return `**Create MR**: Create a merge request on GitLab:
   **Option A — glab CLI (if available):**
   \`glab mr create --fill${branchArg} --yes\`

   **Option B — curl with GITLAB_TOKEN:**
   \`\`\`bash
   GITLAB_PROJECT=$(git remote get-url origin | sed 's/.*gitlab\\.com[:/]//;s/\\.git$//' | python3 -c "import sys,urllib.parse; print(urllib.parse.quote(sys.stdin.read().strip(), safe=''))")
   BRANCH=$(git branch --show-current)
   curl --request POST \\
     --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \\
     --header "Content-Type: application/json" \\
     --data "{\\"source_branch\\":\\"$BRANCH\\",\\"target_branch\\":\\"${targetBranch ?? "main"}\\",\\"title\\":\\"<conventional-commit-title>\\",\\"description\\":\\"<markdown-summary>\\"}" \\
     "https://gitlab.com/api/v4/projects/$GITLAB_PROJECT/merge_requests"
   \`\`\`
   Capture the MR URL (\`web_url\`) from the output.`;
	}

	if (platform === "bitbucket") {
		const dest = targetBranch ?? "main";
		return `**Create PR**: Create a pull request on Bitbucket:
   \`\`\`bash
   WORKSPACE=$(git remote get-url origin | sed 's/.*bitbucket\\.org[:/]//;s/\\/.*$//')
   REPO=$(git remote get-url origin | sed 's/.*bitbucket\\.org[:/][^/]*\\///;s/\\.git$//')
   BRANCH=$(git branch --show-current)
   curl -X POST \\
     -H "Authorization: Basic $(printf '%s:%s' "$BITBUCKET_USERNAME" "$BITBUCKET_TOKEN" | base64)" \\
     -H "Content-Type: application/json" \\
     "https://api.bitbucket.org/2.0/repositories/$WORKSPACE/$REPO/pullrequests" \\
     --data "{\\"title\\":\\"<conventional-commit-title>\\",\\"description\\":\\"<markdown-summary>\\",\\"source\\":{\\"branch\\":{\\"name\\":\\"$BRANCH\\"}},\\"destination\\":{\\"branch\\":{\\"name\\":\\"${dest}\\"}}}"
   \`\`\`
   Capture the PR URL (\`links.html.href\`) from the output.`;
	}

	// Default: GitHub CLI or token
	return `**Create PR**: Create a pull request using the GitHub CLI:
   \`gh pr create --title "<conventional-commit-title>" --body "<markdown-summary>"${base}\`
   Capture the PR URL from the output.`;
}

/**
 * Resolves the authenticated user for the given platform.
 * Returns the username/login, or null if resolution fails.
 */
async function resolveAuthenticatedUser(platform: PRPlatform): Promise<string | null> {
	try {
		if (platform === "gitlab") {
			return await getGitLabAuthenticatedUser();
		}
		if (platform === "bitbucket") {
			// Bitbucket doesn't support assignees, but we still resolve for reviewer filtering
			return null;
		}
		// "cli" or "token" — GitHub
		return await getGitHubAuthenticatedUser(platform);
	} catch {
		return null;
	}
}

/**
 * Applies PR reviewers and assignees after PR creation. Non-fatal.
 * Resolves `self` keyword, filters `self` from reviewers, dispatches to platform APIs.
 */
export async function applyPrReviewersAndAssignees(
	prUrl: string,
	prConfig: PrConfig | undefined,
	platform: PRPlatform,
): Promise<void> {
	if (!prConfig) return;

	const rawReviewers = prConfig.reviewers ?? [];
	const rawAssignees = prConfig.assignees ?? [];
	if (!rawReviewers.length && !rawAssignees.length) return;

	try {
		// Resolve `self` once for both arrays
		const hasSelf = rawReviewers.includes("self") || rawAssignees.includes("self");
		let selfUsername: string | null = null;
		if (hasSelf) {
			selfUsername = await resolveAuthenticatedUser(platform);
		}

		// Filter `self` from reviewers (cannot self-review) and resolve in assignees
		const reviewers = rawReviewers.filter((r) => r !== "self").filter((r) => r !== selfUsername); // Also filter resolved self username from reviewers

		const assignees = rawAssignees
			.map((a) => {
				if (a === "self") return selfUsername;
				return a;
			})
			.filter((a): a is string => a !== null);

		if (selfUsername && rawReviewers.includes("self")) {
			warn("Filtered 'self' from reviewers — cannot request review from yourself");
		}

		// Dispatch to platform-specific implementations
		if (platform === "gitlab") {
			// GitLab uses a combined PUT for both reviewers and assignees
			await addMrReviewersAndAssignees(prUrl, reviewers, assignees);
		} else if (platform === "bitbucket") {
			// Bitbucket: only reviewers, no assignees
			if (reviewers.length) await addBitbucketReviewers(prUrl, reviewers);
		} else {
			// GitHub: parallel reviewer + assignee calls (different endpoints)
			const tasks: Promise<void>[] = [];
			if (reviewers.length) tasks.push(addGitHubReviewers(prUrl, reviewers));
			if (assignees.length) tasks.push(addGitHubAssignees(prUrl, assignees));
			await Promise.allSettled(tasks);
		}
	} catch (err) {
		warn(`Failed to add reviewers/assignees: ${formatError(err)}`);
	}
}

/**
 * Lists repository contributors/members for the given platform. Non-fatal.
 * Returns usernames sorted alphabetically.
 */
export async function listPlatformContributors(
	platform: PRPlatform,
	cwd: string,
): Promise<string[]> {
	try {
		if (platform === "gitlab") {
			return await listGitLabMembers(cwd);
		}
		if (platform === "bitbucket") {
			return await listBitbucketMembers(cwd);
		}
		// "cli" or "token" — GitHub
		return await listGitHubCollaborators(cwd, platform);
	} catch {
		return [];
	}
}

/**
 * Adds a single reviewer to a PR/MR. Non-fatal.
 */
export async function addPlatformReviewer(
	prUrl: string,
	reviewer: string,
	platform: PRPlatform,
): Promise<void> {
	try {
		if (platform === "gitlab") {
			await addMrReviewersAndAssignees(prUrl, [reviewer], []);
		} else if (platform === "bitbucket") {
			await addBitbucketReviewers(prUrl, [reviewer]);
		} else {
			await addGitHubReviewers(prUrl, [reviewer]);
		}
	} catch (err) {
		warn(`Failed to add reviewer "${reviewer}": ${formatError(err)}`);
	}
}

/**
 * Removes a single reviewer from a PR/MR. Non-fatal.
 */
export async function removePlatformReviewer(
	prUrl: string,
	reviewer: string,
	platform: PRPlatform,
): Promise<void> {
	try {
		if (platform === "gitlab") {
			await removeGitLabReviewers(prUrl, [reviewer]);
		} else if (platform === "bitbucket") {
			await removeBitbucketReviewers(prUrl, [reviewer]);
		} else {
			await removeGitHubReviewers(prUrl, [reviewer]);
		}
	} catch (err) {
		warn(`Failed to remove reviewer "${reviewer}": ${formatError(err)}`);
	}
}
