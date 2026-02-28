import type { PRPlatform } from "../types/index.js";
import { appendPrAttribution as appendBitbucketAttribution } from "./bitbucket.js";
import { appendPrAttribution as appendGitHubAttribution } from "./github.js";
import { appendMrAttribution as appendGitLabAttribution } from "./gitlab.js";

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
     -H "Authorization: Bearer $BITBUCKET_TOKEN" \\
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
