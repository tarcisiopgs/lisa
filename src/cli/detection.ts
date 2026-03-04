import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import * as clack from "@clack/prompts";
import { isGhCliAvailable } from "../git/github.js";
import type { PRPlatform, RepoConfig, SourceName } from "../types/index.js";

export function getVersion(): string {
	try {
		const pkgPath = resolvePath(new URL(".", import.meta.url).pathname, "../package.json");
		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };
		return pkg.version;
	} catch {
		return "0.0.0";
	}
}

const CURSOR_FREE_PLAN_ERROR = "Free plans can only use Auto";

export async function isCursorFreePlan(): Promise<boolean> {
	const { mkdtempSync, unlinkSync, writeFileSync } = await import("node:fs");
	const tmpDir = mkdtempSync(join(tmpdir(), "lisa-cursor-check-"));
	const promptFile = join(tmpDir, "prompt.txt");
	writeFileSync(promptFile, "test", "utf-8");

	try {
		const bin = ["agent", "cursor-agent"].find((b) => {
			try {
				execSync(`${b} --version`, { stdio: "ignore" });
				return true;
			} catch {
				return false;
			}
		});
		if (!bin) return false;

		const output = execSync(`${bin} -p "$(cat '${promptFile}')" --output-format text`, {
			cwd: process.cwd(),
			encoding: "utf-8",
			timeout: 30000,
		});
		return output.includes(CURSOR_FREE_PLAN_ERROR);
	} catch (err) {
		const errorOutput = err instanceof Error ? err.message : String(err);
		return errorOutput.includes(CURSOR_FREE_PLAN_ERROR);
	} finally {
		try {
			unlinkSync(promptFile);
		} catch {}
		try {
			execSync(`rm -rf ${tmpDir}`, { stdio: "ignore" });
		} catch {}
	}
}

// Curated list of Cursor models shown on paid plans — top-tier only, no quality-suffix variants
const CURSOR_PREFERRED_MODELS = [
	"auto",
	"composer-1.5",
	"composer-1",
	"gpt-5.3-codex",
	"gpt-5.2",
	"gpt-5.1-codex-max",
	"opus-4.6-thinking",
	"opus-4.6",
	"sonnet-4.6-thinking",
	"sonnet-4.6",
	"gemini-3.1-pro",
	"gemini-3-pro",
	"grok",
	"kimi-k2.5",
];

export function fetchCursorModels(): string[] {
	try {
		const bin = ["agent", "cursor-agent"].find((b) => {
			try {
				execSync(`${b} --version`, { stdio: "ignore" });
				return true;
			} catch {
				return false;
			}
		});
		if (!bin) return CURSOR_PREFERRED_MODELS;
		const raw = execSync(`${bin} --list-models`, { encoding: "utf-8", timeout: 10000 });
		// Strip ANSI escape codes, parse "model-id - Display Name" lines
		// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI strip
		const clean = raw.replace(/\x1b\[[0-9;]*[mGKHFA-Z]/g, "");
		const all = clean
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.includes(" - "))
			.map((l) => (l.split(" - ")[0] ?? "").trim())
			.filter(Boolean);
		// Filter to curated list, preserving preferred order
		const filtered = CURSOR_PREFERRED_MODELS.filter((m) => all.includes(m));
		return filtered.length > 0 ? filtered : CURSOR_PREFERRED_MODELS;
	} catch {
		return CURSOR_PREFERRED_MODELS;
	}
}

export function fetchOpenCodeModels(): string[] {
	try {
		const raw = execSync("opencode models", { encoding: "utf-8", timeout: 10000 });

		// Determine which providers the user has credentials for
		const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY);
		const hasGoogle = Boolean(
			process.env.GEMINI_API_KEY ||
				process.env.GOOGLE_API_KEY ||
				process.env.GOOGLE_GENERATIVE_AI_API_KEY,
		);
		const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);
		const hasCopilot = Boolean(process.env.GITHUB_COPILOT_API_KEY || process.env.GITHUB_TOKEN);
		const hasGroq = Boolean(process.env.GROQ_API_KEY);
		const hasMistral = Boolean(process.env.MISTRAL_API_KEY);
		const hasDeepSeek = Boolean(process.env.DEEPSEEK_API_KEY);

		return raw
			.split("\n")
			.map((l) => l.trim())
			.filter((m) => {
				// Always include free OpenCode proprietary models
				if (/^opencode\//.test(m)) return true;
				// Provider-gated: only show if credentials are present
				if (/^anthropic\/claude-(opus|sonnet|haiku)-4-\d+$/.test(m)) return hasAnthropic;
				if (
					/^google\/gemini-(3\.1-pro-preview|3-pro-preview|3-flash-preview|2\.5-(pro|flash|flash-lite))$/.test(
						m,
					)
				)
					return hasGoogle;
				if (/^openai\//.test(m)) return hasOpenAI;
				if (/^github-copilot\//.test(m)) return hasCopilot;
				if (/^groq\//.test(m)) return hasGroq;
				if (/^mistral\//.test(m)) return hasMistral;
				if (/^deepseek\//.test(m)) return hasDeepSeek;
				return false;
			});
	} catch {
		return [];
	}
}

export function detectPlatformFromRemoteUrl(remoteUrl: string): PRPlatform | null {
	if (/github\.com/.test(remoteUrl)) return "cli"; // GitHub → default to CLI
	if (/gitlab\./.test(remoteUrl)) return "gitlab";
	if (/bitbucket\.org/.test(remoteUrl)) return "bitbucket";
	return null;
}

export async function detectPlatform(): Promise<PRPlatform> {
	// Try to detect from git remote
	let detectedPlatform: PRPlatform | null = null;
	try {
		const remoteUrl = execSync("git remote get-url origin", {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
		detectedPlatform = detectPlatformFromRemoteUrl(remoteUrl);
		if (detectedPlatform) {
			const platformLabel =
				detectedPlatform === "cli" || detectedPlatform === "token"
					? "GitHub"
					: detectedPlatform === "gitlab"
						? "GitLab"
						: "Bitbucket";
			clack.log.info(`Detected ${platformLabel} remote`);
		}
	} catch {
		// Not in a git repo or no remote — skip detection
	}

	const initialValue: PRPlatform = detectedPlatform ?? "cli";

	const selected = await clack.select({
		message: "How should Lisa create pull requests?",
		initialValue,
		options: [
			{ value: "cli", label: "GitHub CLI", hint: "uses `gh pr create` — recommended for GitHub" },
			{ value: "token", label: "GitHub API", hint: "uses GITHUB_TOKEN directly" },
			{ value: "gitlab", label: "GitLab API", hint: "uses GITLAB_TOKEN (glab or REST API)" },
			{ value: "bitbucket", label: "Bitbucket API", hint: "uses BITBUCKET_TOKEN (REST API)" },
		],
	});
	if (clack.isCancel(selected)) return process.exit(0);
	const platform = selected as PRPlatform;

	await verifyPlatformCredential(platform);

	return platform;
}

export async function verifyPlatformCredential(platform: PRPlatform): Promise<void> {
	if (platform === "cli") {
		const hasCli = await isGhCliAvailable();
		if (!hasCli) {
			clack.log.warning(
				"GitHub CLI (`gh`) is not authenticated. Run `gh auth login` before using Lisa.",
			);
		}
		return;
	}
	if (platform === "token") {
		if (!process.env.GITHUB_TOKEN) {
			clack.log.warning("GITHUB_TOKEN is not set. Add it to your shell profile.");
		}
		return;
	}
	if (platform === "gitlab") {
		if (!process.env.GITLAB_TOKEN) {
			clack.log.warning("GITLAB_TOKEN is not set. Add it to your shell profile.");
		}
		return;
	}
	if (platform === "bitbucket") {
		if (!process.env.BITBUCKET_TOKEN) {
			clack.log.warning("BITBUCKET_TOKEN is not set. Add it to your shell profile.");
		}
		return;
	}
}

export async function detectGitRepos(): Promise<RepoConfig[]> {
	const cwd = process.cwd();

	// If current directory is a git repo, no sub-repos needed
	if (existsSync(join(cwd, ".git"))) {
		clack.log.info("Found a git repository in the current directory.");
		return [];
	}

	// Scan immediate subdirectories for git repos
	const entries = readdirSync(cwd, { withFileTypes: true });
	const gitDirs = entries
		.filter((e) => e.isDirectory() && existsSync(join(cwd, e.name, ".git")))
		.map((e) => e.name);

	if (gitDirs.length === 0) {
		return [];
	}

	const selected = await clack.multiselect({
		message: "Multiple git repositories found — which ones should Lisa work on?",
		options: gitDirs.map((dir) => ({ value: dir, label: dir })),
	});

	if (clack.isCancel(selected)) return process.exit(0);

	return (selected as string[]).map((dir) => ({
		name: getGitRepoName(join(cwd, dir)) ?? dir,
		path: `./${dir}`,
		match: "",
		base_branch: "",
	}));
}

export function detectDefaultBranch(repoPath: string): string {
	try {
		const ref = execSync("git symbolic-ref refs/remotes/origin/HEAD --short", {
			cwd: repoPath,
			encoding: "utf-8",
		}).trim();
		return ref.replace("origin/", "");
	} catch {
		return "main";
	}
}

export function getGitRepoName(repoPath: string): string | null {
	try {
		const url = execSync("git remote get-url origin", { cwd: repoPath, encoding: "utf-8" }).trim();
		// Handle both HTTPS (https://github.com/org/repo.git) and SSH (git@github.com:org/repo.git)
		const match = url.match(/\/([^/]+?)(?:\.git)?$/) ?? url.match(/:([^/]+?)(?:\.git)?$/);
		return match?.[1] ?? null;
	} catch {
		return null;
	}
}

export async function getMissingEnvVars(source: SourceName): Promise<string[]> {
	const missing: string[] = [];

	if (!process.env.GITHUB_TOKEN) {
		const ghAvailable = await isGhCliAvailable();
		if (!ghAvailable) missing.push("GITHUB_TOKEN");
	}

	if (source === "linear") {
		if (!process.env.LINEAR_API_KEY) missing.push("LINEAR_API_KEY");
	} else if (source === "trello") {
		if (!process.env.TRELLO_API_KEY) missing.push("TRELLO_API_KEY");
		if (!process.env.TRELLO_TOKEN) missing.push("TRELLO_TOKEN");
	} else if (source === "github-issues") {
		// GITHUB_TOKEN already checked above
	} else if (source === "gitlab-issues") {
		if (!process.env.GITLAB_TOKEN) missing.push("GITLAB_TOKEN");
	} else if (source === "plane") {
		if (!process.env.PLANE_API_TOKEN) missing.push("PLANE_API_TOKEN");
	} else if (source === "shortcut") {
		if (!process.env.SHORTCUT_API_TOKEN) missing.push("SHORTCUT_API_TOKEN");
	} else if (source === "jira") {
		if (!process.env.JIRA_BASE_URL) missing.push("JIRA_BASE_URL");
		if (!process.env.JIRA_EMAIL) missing.push("JIRA_EMAIL");
		if (!process.env.JIRA_API_TOKEN) missing.push("JIRA_API_TOKEN");
	}

	return missing;
}
