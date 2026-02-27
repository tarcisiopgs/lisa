import { execa } from "execa";
import { stripProviderAttribution } from "./pr-body.js";

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

function getToken(): string {
	const token = process.env.GITLAB_TOKEN;
	if (!token) throw new Error("GITLAB_TOKEN is not set");
	return token;
}

export interface GitLabRepoInfo {
	host: string;
	namespace: string;
	project: string;
	branch: string;
	defaultBranch: string;
}

export interface MergeRequestOptions {
	namespace: string;
	project: string;
	sourceBranch: string;
	targetBranch: string;
	title: string;
	description: string;
	host?: string;
}

export interface MergeRequestResult {
	iid: number;
	web_url: string;
}

export async function getGitLabRepoInfo(cwd: string): Promise<GitLabRepoInfo> {
	const { stdout: remoteUrl } = await execa("git", ["remote", "get-url", "origin"], { cwd });

	let host: string;
	let namespace: string;
	let project: string;

	// SSH: git@gitlab.com:namespace/project.git
	const sshMatch = remoteUrl.match(/git@([^:]+):(.+?)\/(.+?)(?:\.git)?$/);
	// HTTPS: https://gitlab.com/namespace/project.git
	const httpsMatch = remoteUrl.match(/https?:\/\/([^/]+)\/(.+?)\/(.+?)(?:\.git)?$/);

	if (sshMatch) {
		host = sshMatch[1] ?? "gitlab.com";
		namespace = sshMatch[2] ?? "";
		project = sshMatch[3] ?? "";
	} else if (httpsMatch) {
		host = httpsMatch[1] ?? "gitlab.com";
		namespace = httpsMatch[2] ?? "";
		project = httpsMatch[3] ?? "";
	} else {
		throw new Error(`Cannot parse GitLab namespace/project from remote URL: ${remoteUrl}`);
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
		host,
		namespace,
		project,
		branch: branch.trim(),
		defaultBranch: defaultBranchRaw.replace("origin/", "").trim(),
	};
}

function buildApiBase(host: string): string {
	return `https://${host}/api/v4`;
}

function encodeProjectPath(namespace: string, project: string): string {
	return encodeURIComponent(`${namespace}/${project}`);
}

export async function createMergeRequest(opts: MergeRequestOptions): Promise<MergeRequestResult> {
	const token = getToken();
	const host = opts.host ?? "gitlab.com";
	const apiBase = buildApiBase(host);
	const encodedPath = encodeProjectPath(opts.namespace, opts.project);

	const res = await fetch(`${apiBase}/projects/${encodedPath}/merge_requests`, {
		method: "POST",
		headers: {
			"PRIVATE-TOKEN": token,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			source_branch: opts.sourceBranch,
			target_branch: opts.targetBranch,
			title: opts.title,
			description: opts.description,
			remove_source_branch: false,
		}),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`GitLab API error (${res.status}): ${text}`);
	}

	const data = (await res.json()) as { iid: number; web_url: string };
	return { iid: data.iid, web_url: data.web_url };
}

export async function appendMrAttribution(mrUrl: string, providerUsed: string): Promise<void> {
	try {
		// Parse MR URL: https://gitlab.com/namespace/project/-/merge_requests/123
		const match = mrUrl.match(/https?:\/\/([^/]+)\/(.+?)\/-\/merge_requests\/(\d+)/);
		if (!match) return;

		const [, host, projectPath, iidStr] = match;
		const token = process.env.GITLAB_TOKEN;
		if (!token) return;

		const apiBase = buildApiBase(host ?? "gitlab.com");
		const encodedPath = encodeURIComponent(projectPath ?? "");
		const iid = iidStr;

		// Fetch current MR description
		const getRes = await fetch(`${apiBase}/projects/${encodedPath}/merge_requests/${iid}`, {
			headers: { "PRIVATE-TOKEN": token },
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!getRes.ok) return;

		const mrData = (await getRes.json()) as { description: string };
		const currentDescription = mrData.description ?? "";

		const providerName = formatProviderName(providerUsed);
		const attribution = `\n\n---\n🤖 Resolved by [lisa](https://github.com/tarcisiopgs/lisa) using **${providerName}**`;
		const newDescription = stripProviderAttribution(currentDescription) + attribution;

		// Update MR description
		await fetch(`${apiBase}/projects/${encodedPath}/merge_requests/${iid}`, {
			method: "PUT",
			headers: {
				"PRIVATE-TOKEN": token,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ description: newDescription }),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch {
		// Non-fatal — attribution is best-effort
	}
}

export function isGitLabUrl(url: string): boolean {
	return /gitlab\./.test(url) && url.includes("merge_requests");
}
