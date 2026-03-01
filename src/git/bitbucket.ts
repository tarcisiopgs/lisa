import { execa } from "execa";
import { stripProviderAttribution } from "./pr-body.js";

const API_URL = "https://api.bitbucket.org/2.0";
const REQUEST_TIMEOUT_MS = 30_000;

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
	claude: "Claude Code",
	gemini: "Gemini CLI",
	opencode: "OpenCode",
	copilot: "GitHub Copilot CLI",
	cursor: "Cursor Agent",
	goose: "Goose",
	aider: "Aider",
	codex: "OpenAI Codex",
};

function formatProviderName(providerUsed: string): string {
	const providerKey = providerUsed.split("/")[0] ?? providerUsed;
	return PROVIDER_DISPLAY_NAMES[providerKey] ?? providerKey;
}

function getAuthHeader(): string {
	const token = process.env.BITBUCKET_TOKEN;
	if (!token) throw new Error("BITBUCKET_TOKEN is not set");
	const username = process.env.BITBUCKET_USERNAME;
	if (!username) throw new Error("BITBUCKET_USERNAME is not set");
	const credentials = Buffer.from(`${username}:${token}`).toString("base64");
	return `Basic ${credentials}`;
}

export interface BitbucketRepoInfo {
	workspace: string;
	repoSlug: string;
	branch: string;
	defaultBranch: string;
}

export interface PullRequestOptions {
	workspace: string;
	repoSlug: string;
	sourceBranch: string;
	destinationBranch: string;
	title: string;
	description: string;
}

export interface PullRequestResult {
	id: number;
	html_url: string;
}

export async function getBitbucketRepoInfo(cwd: string): Promise<BitbucketRepoInfo> {
	const { stdout: remoteUrl } = await execa("git", ["remote", "get-url", "origin"], { cwd });

	let workspace: string;
	let repoSlug: string;

	// SSH: git@bitbucket.org:workspace/repo_slug.git
	const sshMatch = remoteUrl.match(/git@bitbucket\.org:(.+?)\/(.+?)(?:\.git)?$/);
	// HTTPS: https://bitbucket.org/workspace/repo_slug.git or https://user@bitbucket.org/workspace/repo_slug.git
	const httpsMatch = remoteUrl.match(
		/https?:\/\/(?:[^@]+@)?bitbucket\.org\/(.+?)\/(.+?)(?:\.git)?$/,
	);

	if (sshMatch) {
		workspace = sshMatch[1] ?? "";
		repoSlug = sshMatch[2] ?? "";
	} else if (httpsMatch) {
		workspace = httpsMatch[1] ?? "";
		repoSlug = httpsMatch[2] ?? "";
	} else {
		throw new Error(`Cannot parse Bitbucket workspace/repo from remote URL: ${remoteUrl}`);
	}

	const { stdout: branch } = await execa("git", ["branch", "--show-current"], { cwd });
	const { stdout: defaultBranchRaw } = await execa(
		"git",
		["symbolic-ref", "refs/remotes/origin/HEAD", "--short"],
		{ cwd, reject: false },
	).then(
		(r) => r,
		() => ({ stdout: "origin/main" }),
	);

	return {
		workspace,
		repoSlug,
		branch: branch.trim(),
		defaultBranch: defaultBranchRaw.replace("origin/", "").trim(),
	};
}

export async function createPullRequest(opts: PullRequestOptions): Promise<PullRequestResult> {
	const res = await fetch(
		`${API_URL}/repositories/${opts.workspace}/${opts.repoSlug}/pullrequests`,
		{
			method: "POST",
			headers: {
				Authorization: getAuthHeader(),
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				title: opts.title,
				description: opts.description,
				source: { branch: { name: opts.sourceBranch } },
				destination: { branch: { name: opts.destinationBranch } },
			}),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		},
	);

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Bitbucket API error (${res.status}): ${text}`);
	}

	const data = (await res.json()) as { id: number; links: { html: { href: string } } };
	return { id: data.id, html_url: data.links.html.href };
}

export async function appendPrAttribution(prUrl: string, providerUsed: string): Promise<void> {
	try {
		// Parse PR URL: https://bitbucket.org/workspace/repo_slug/pull-requests/123
		const match = prUrl.match(/bitbucket\.org\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)/);
		if (!match) return;

		const [, workspace, repoSlug, prId] = match;
		if (!process.env.BITBUCKET_TOKEN || !process.env.BITBUCKET_USERNAME) return;
		const authHeader = getAuthHeader();

		// Fetch current PR description
		const getRes = await fetch(
			`${API_URL}/repositories/${workspace}/${repoSlug}/pullrequests/${prId}`,
			{
				headers: { Authorization: authHeader },
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			},
		);
		if (!getRes.ok) return;

		const prData = (await getRes.json()) as { description: string };
		const currentDescription = prData.description ?? "";

		const providerName = formatProviderName(providerUsed);
		const attribution = `\n\n---\n🤖 Resolved by [lisa](https://github.com/tarcisiopgs/lisa) using **${providerName}**`;
		const newDescription = stripProviderAttribution(currentDescription) + attribution;

		// Update PR description
		await fetch(`${API_URL}/repositories/${workspace}/${repoSlug}/pullrequests/${prId}`, {
			method: "PUT",
			headers: {
				Authorization: authHeader,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ description: newDescription }),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch {
		// Non-fatal — attribution is best-effort
	}
}

export function isBitbucketUrl(url: string): boolean {
	return url.includes("bitbucket.org") && url.includes("pull-requests");
}
