import { execa } from "execa";
import type { PRPlatform } from "../types/index.js";
import { PROVIDER_ATTRIBUTION_RE, stripProviderAttribution } from "./pr-body.js";

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
			`/repos/${owner}/${repo}/issues/${prNumber}/comments`,
		]);
		const comments = JSON.parse(stdout) as Array<{ id: number; body: string }>;

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
	const { stdout: defaultBranch } = await execa(
		"git",
		["symbolic-ref", "refs/remotes/origin/HEAD", "--short"],
		{ cwd, reject: false },
	).then(
		(r) => r,
		() => ({ stdout: "origin/main" }),
	);

	return {
		owner,
		repo,
		branch: branch.trim(),
		defaultBranch: defaultBranch.replace("origin/", "").trim(),
	};
}
