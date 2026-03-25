export interface ParsedGitHubUrl {
	owner: string;
	repo: string;
	number: number;
}

export interface ParsedGitLabUrl {
	host: string;
	projectPath: string;
	iid: number;
}

export interface ParsedBitbucketUrl {
	workspace: string;
	repoSlug: string;
	id: number;
}

/**
 * Parses a GitHub PR URL into its components.
 * Returns null if the URL does not match the expected format.
 */
export function parseGitHubPrUrl(prUrl: string): ParsedGitHubUrl | null {
	const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
	if (!match) return null;
	const num = Number.parseInt(match[3] ?? "0", 10);
	if (num <= 0) return null;
	return { owner: match[1] ?? "", repo: match[2] ?? "", number: num };
}

/**
 * Parses a GitLab MR URL into its components.
 * Returns null if the URL does not match the expected format.
 */
export function parseGitLabMrUrl(mrUrl: string): ParsedGitLabUrl | null {
	const match = mrUrl.match(/https?:\/\/([^/]+)\/(.+?)\/-\/merge_requests\/(\d+)/);
	if (!match) return null;
	const iid = Number.parseInt(match[3] ?? "0", 10);
	if (iid <= 0) return null;
	return { host: match[1] ?? "", projectPath: match[2] ?? "", iid };
}

/**
 * Parses a Bitbucket PR URL into its components.
 * Returns null if the URL does not match the expected format.
 */
export function parseBitbucketPrUrl(prUrl: string): ParsedBitbucketUrl | null {
	const match = prUrl.match(/bitbucket\.org\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)/);
	if (!match) return null;
	const id = Number.parseInt(match[3] ?? "0", 10);
	if (id <= 0) return null;
	return { workspace: match[1] ?? "", repoSlug: match[2] ?? "", id };
}
