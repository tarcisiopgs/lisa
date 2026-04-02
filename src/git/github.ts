import { execa } from "execa";
import type { PRPlatform } from "../types/index.js";
import { PROVIDER_ATTRIBUTION_RE, stripProviderAttribution } from "./pr-body.js";
import { parseGitHubPrUrl } from "./url-parser.js";

const API_URL = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 30_000;

export async function isGhCliAvailable(): Promise<boolean> {
	try {
		await execa("gh", ["auth", "status"]);
		return true;
	} catch {
		return false;
	}
}

function getToken(): string {
	const token = process.env.GITHUB_TOKEN;
	if (!token) throw new Error("GITHUB_TOKEN is not set");
	return token;
}

export interface PullRequestOptions {
	owner: string;
	repo: string;
	head: string;
	base: string;
	title: string;
	body: string;
}

export interface PullRequestResult {
	number: number;
	html_url: string;
}

export async function createPullRequest(
	opts: PullRequestOptions,
	method: PRPlatform = "cli",
): Promise<PullRequestResult> {
	if (method === "cli" && (await isGhCliAvailable())) {
		return createPullRequestWithGhCli(opts);
	}

	const res = await fetch(`${API_URL}/repos/${opts.owner}/${opts.repo}/pulls`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${getToken()}`,
			Accept: "application/vnd.github+json",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			title: opts.title,
			body: opts.body,
			head: opts.head,
			base: opts.base,
		}),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`GitHub API error (${res.status}): ${text}`);
	}

	const data = (await res.json()) as { number: number; html_url: string };
	return { number: data.number, html_url: data.html_url };
}

async function createPullRequestWithGhCli(opts: PullRequestOptions): Promise<PullRequestResult> {
	const result = await execa("gh", [
		"pr",
		"create",
		"--repo",
		`${opts.owner}/${opts.repo}`,
		"--head",
		opts.head,
		"--base",
		opts.base,
		"--title",
		opts.title,
		"--body",
		opts.body,
	]);

	// gh pr create outputs the PR URL
	const url = result.stdout.trim();
	const prNumberMatch = url.match(/\/pull\/(\d+)/);
	const number = prNumberMatch ? Number.parseInt(prNumberMatch[1] ?? "0", 10) : 0;

	return { number, html_url: url };
}

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

async function deleteProviderComments(prUrl: string): Promise<void> {
	try {
		const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
		if (!match) return;

		const [, owner, repo, prNumber] = match;
		const { stdout } = await execa("gh", [
			"api",
			"--paginate",
			"--jq",
			".[]",
			`/repos/${owner}/${repo}/issues/${prNumber}/comments`,
		]);
		const comments = stdout
			.trim()
			.split("\n")
			.filter(Boolean)
			.flatMap((line) => {
				try {
					return [JSON.parse(line) as { id: number; body: string }];
				} catch {
					return [];
				}
			});

		for (const comment of comments) {
			if (PROVIDER_ATTRIBUTION_RE.test(comment.body)) {
				try {
					await execa("gh", [
						"api",
						"--method",
						"DELETE",
						`/repos/${owner}/${repo}/issues/comments/${comment.id}`,
					]);
				} catch {
					// Best-effort: ignore individual deletion failures
				}
			}
		}
	} catch {
		// Non-fatal — comment deletion is best-effort
	}
}

export async function appendPrAttribution(prUrl: string, providerUsed: string): Promise<void> {
	await deleteProviderComments(prUrl);
	try {
		const { stdout: bodyJson } = await execa("gh", ["pr", "view", prUrl, "--json", "body"]);
		const { body } = JSON.parse(bodyJson) as { body: string };
		const providerName = formatProviderName(providerUsed);
		const attribution = `\n\n---\n🤖 Resolved by [lisa](https://github.com/tarcisiopgs/lisa) using **${providerName}**`;
		const newBody = stripProviderAttribution(body ?? "") + attribution;
		await execa("gh", ["pr", "edit", prUrl, "--body", newBody]);
	} catch {
		// Non-fatal — PR body update is best-effort
	}
}

/**
 * Appends arbitrary content to a GitHub PR body. Non-fatal.
 */
export async function appendPrBody(prUrl: string, content: string): Promise<void> {
	try {
		const { stdout: bodyJson } = await execa("gh", ["pr", "view", prUrl, "--json", "body"]);
		const { body } = JSON.parse(bodyJson) as { body: string };
		const newBody = (body ?? "") + content;
		await execa("gh", ["pr", "edit", prUrl, "--body", newBody]);
	} catch {
		// Non-fatal
	}
}

export interface RepoInfo {
	owner: string;
	repo: string;
	branch: string;
	defaultBranch: string;
}

export async function getRepoInfo(cwd: string): Promise<RepoInfo> {
	const { stdout: remoteUrl } = await execa("git", ["remote", "get-url", "origin"], { cwd });

	// Parse owner/repo from remote URL
	// Supports: git@github.com:owner/repo.git and https://github.com/owner/repo.git
	let owner: string;
	let repo: string;

	const sshMatch = remoteUrl.match(/git@github\.com:(.+?)\/(.+?)(?:\.git)?$/);
	const httpsMatch = remoteUrl.match(/github\.com\/(.+?)\/(.+?)(?:\.git)?$/);

	if (sshMatch) {
		owner = sshMatch[1] ?? "";
		repo = sshMatch[2] ?? "";
	} else if (httpsMatch) {
		owner = httpsMatch[1] ?? "";
		repo = httpsMatch[2] ?? "";
	} else {
		throw new Error(`Cannot parse GitHub owner/repo from remote URL: ${remoteUrl}`);
	}

	const { stdout: branch } = await execa("git", ["branch", "--show-current"], { cwd });

	// Get the default branch (usually main or master)
	let defaultBranch = "main";
	const symResult = await execa("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"], {
		cwd,
		reject: false,
	});
	if (symResult.stdout?.trim()) {
		defaultBranch = symResult.stdout.replace("origin/", "").trim();
	} else {
		// Fallback: check which common branch names actually exist on the remote
		for (const candidate of ["main", "master", "develop"]) {
			const check = await execa("git", ["rev-parse", "--verify", `origin/${candidate}`], {
				cwd,
				reject: false,
			});
			if (check.exitCode === 0) {
				defaultBranch = candidate;
				break;
			}
		}
	}

	return {
		owner,
		repo,
		branch: branch.trim(),
		defaultBranch,
	};
}

/**
 * Lists repository collaborators (users with push access).
 * Uses gh CLI or GitHub API. Returns usernames sorted alphabetically.
 */
export async function listCollaborators(
	cwd: string,
	method: PRPlatform = "cli",
): Promise<string[]> {
	try {
		const { owner, repo } = await getRepoInfo(cwd);

		if (method === "cli" && (await isGhCliAvailable())) {
			const { stdout } = await execa("gh", [
				"api",
				"--paginate",
				"--jq",
				".[].login",
				`/repos/${owner}/${repo}/collaborators`,
			]);
			return stdout
				.trim()
				.split("\n")
				.filter(Boolean)
				.sort((a, b) => a.localeCompare(b));
		}

		const res = await fetch(`${API_URL}/repos/${owner}/${repo}/collaborators?per_page=100`, {
			headers: {
				Authorization: `Bearer ${getToken()}`,
				Accept: "application/vnd.github+json",
			},
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!res.ok) return [];
		const data = (await res.json()) as { login: string }[];
		return data
			.map((c) => c.login)
			.filter(Boolean)
			.sort((a, b) => a.localeCompare(b));
	} catch {
		return [];
	}
}

/**
 * Removes requested reviewers from a GitHub PR. Non-fatal.
 */
export async function removeReviewers(prUrl: string, reviewers: string[]): Promise<void> {
	if (!reviewers.length) return;
	const parsed = parseGitHubPrUrl(prUrl);
	if (!parsed) return;

	await execa(
		"gh",
		[
			"api",
			"--method",
			"DELETE",
			`/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}/requested_reviewers`,
			"--input",
			"-",
		],
		{
			input: JSON.stringify({ reviewers }),
		},
	);
}

let authenticatedUserCache: string | null = null;

/**
 * Returns the login of the authenticated GitHub user. Cached for process lifetime.
 */
export async function getAuthenticatedUser(method: PRPlatform = "cli"): Promise<string> {
	if (authenticatedUserCache) return authenticatedUserCache;

	if (method === "cli" || method === "token") {
		if (method === "cli") {
			const { stdout } = await execa("gh", ["api", "/user", "--jq", ".login"]);
			authenticatedUserCache = stdout.trim();
		} else {
			const res = await fetch(`${API_URL}/user`, {
				headers: { Authorization: `Bearer ${getToken()}`, Accept: "application/vnd.github+json" },
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			if (!res.ok) throw new Error(`GitHub API error (${res.status})`);
			const data = (await res.json()) as { login: string };
			authenticatedUserCache = data.login;
		}
	}

	if (!authenticatedUserCache) throw new Error("Could not resolve authenticated GitHub user");
	return authenticatedUserCache;
}

/**
 * Requests reviews from the given users on a GitHub PR. Additive (appends to existing reviewers).
 */
export async function addReviewers(prUrl: string, reviewers: string[]): Promise<void> {
	if (!reviewers.length) return;
	const parsed = parseGitHubPrUrl(prUrl);
	if (!parsed) return;

	await execa(
		"gh",
		[
			"api",
			"--method",
			"POST",
			`/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}/requested_reviewers`,
			"--input",
			"-",
		],
		{
			input: JSON.stringify({ reviewers }),
		},
	);
}

/**
 * Adds assignees to a GitHub PR/issue. Additive (appends to existing assignees).
 */
export async function addAssignees(prUrl: string, assignees: string[]): Promise<void> {
	if (!assignees.length) return;
	const parsed = parseGitHubPrUrl(prUrl);
	if (!parsed) return;

	await execa(
		"gh",
		[
			"api",
			"--method",
			"POST",
			`/repos/${parsed.owner}/${parsed.repo}/issues/${parsed.number}/assignees`,
			"--input",
			"-",
		],
		{
			input: JSON.stringify({ assignees }),
		},
	);
}
