import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import * as clack from "@clack/prompts";
import { defineCommand, runMain } from "citty";
import pc from "picocolors";
import { configExists, loadConfig, mergeWithFlags, saveConfig } from "./config.js";
import { isGhCliAvailable } from "./github.js";
import { banner, log, setOutputMode } from "./logger.js";
import { runLoop } from "./loop.js";
import { getAvailableProviders } from "./providers/index.js";
import type {
	GitHubMethod,
	LisaConfig,
	ProviderName,
	RepoConfig,
	SourceName,
	WorkflowMode,
} from "./types.js";
import { ensureWorktreeGitignore } from "./worktree.js";

const run = defineCommand({
	meta: { name: "run", description: "Run the agent loop" },
	args: {
		once: { type: "boolean", description: "Run a single iteration", default: false },
		limit: { type: "string", description: "Max number of issues to process", default: "0" },
		"dry-run": { type: "boolean", description: "Preview without executing", default: false },
		issue: { type: "string", description: "Run a specific issue by identifier or URL" },
		provider: { type: "string", description: "AI provider (claude, gemini, opencode)" },
		source: { type: "string", description: "Issue source (linear, trello)" },
		label: { type: "string", description: "Label to filter issues" },
		github: { type: "string", description: "GitHub method: cli or token" },
		json: { type: "boolean", description: "Output as JSON lines", default: false },
		quiet: { type: "boolean", description: "Suppress non-essential output", default: false },
	},
	async run({ args }) {
		if (args.json) setOutputMode("json");
		else if (args.quiet) setOutputMode("quiet");
		banner();

		if (!configExists()) {
			console.error(pc.red("No configuration found. Run `lisa init` first."));
			process.exit(1);
		}

		const config = loadConfig();
		const merged = mergeWithFlags(config, {
			provider: args.provider as ProviderName | undefined,
			source: args.source as SourceName | undefined,
			github: args.github as GitHubMethod | undefined,
			label: args.label,
		});

		// Validate env vars before running
		const missingVars = await getMissingEnvVars(merged.source);
		if (missingVars.length > 0) {
			const shell = process.env.SHELL?.includes("zsh") ? "~/.zshrc" : "~/.bashrc";
			console.error(
				pc.red(
					`Missing required environment variables:\n${missingVars.map((v) => `  ${v}`).join("\n")}`,
				),
			);
			console.error(pc.dim(`\nAdd them to your ${shell} and run: source ${shell}`));
			process.exit(1);
		}

		await runLoop(merged, {
			once: args.once || !!args.issue,
			limit: Number.parseInt(args.limit, 10),
			dryRun: args["dry-run"],
			issueId: args.issue,
		});
	},
});

const config = defineCommand({
	meta: { name: "config", description: "Manage configuration" },
	args: {
		show: { type: "boolean", description: "Show current config", default: false },
		set: { type: "string", description: "Set a config value (key=value)" },
	},
	async run({ args }) {
		if (args.show) {
			const cfg = loadConfig();
			console.log(pc.cyan("\nCurrent configuration:\n"));
			console.log(JSON.stringify(cfg, null, 2));
			return;
		}

		if (args.set) {
			const [key, value] = args.set.split("=");
			if (!key || !value) {
				console.error(pc.red("Usage: lisa config --set key=value"));
				process.exit(1);
			}
			const cfg = loadConfig();
			(cfg as unknown as Record<string, unknown>)[key] = value;
			saveConfig(cfg);
			log(`Set ${key} = ${value}`);
			return;
		}

		// Interactive wizard
		await runConfigWizard();
	},
});

const init = defineCommand({
	meta: { name: "init", description: "Initialize lisa configuration" },
	async run() {
		if (!process.stdin.isTTY) {
			console.error(
				pc.red("Interactive mode requires a TTY. Cannot run init in non-interactive environments."),
			);
			process.exit(1);
		}
		if (configExists()) {
			const overwrite = await clack.confirm({
				message: "Config already exists. Overwrite?",
			});
			if (clack.isCancel(overwrite) || !overwrite) {
				log("Cancelled.");
				return;
			}
		}
		await runConfigWizard();
	},
});

const status = defineCommand({
	meta: { name: "status", description: "Show session status and stats" },
	async run() {
		banner();
		const config = loadConfig();
		const isLinear = config.source === "linear";
		console.log(pc.cyan("Configuration:"));
		console.log(`  Provider:    ${pc.bold(config.provider)}`);
		console.log(`  Source:      ${pc.bold(config.source)}`);
		console.log(`  Workflow:    ${pc.bold(config.workflow)}`);
		console.log(`  Label:       ${pc.bold(config.source_config.label)}`);
		console.log(`  ${isLinear ? "Team" : "Board"}:       ${pc.bold(config.source_config.team)}`);
		if (isLinear) {
			console.log(`  Project:     ${pc.bold(config.source_config.project)}`);
		}
		console.log(`  Pick from:   ${pc.bold(config.source_config.pick_from)}`);
		console.log(`  In progress: ${pc.bold(config.source_config.in_progress)}`);
		console.log(`  Done:        ${pc.bold(config.source_config.done)}`);
		console.log(`  Logs:        ${pc.dim(config.logs.dir)}`);

		// Count log files
		const { readdirSync, existsSync } = await import("node:fs");
		if (existsSync(config.logs.dir)) {
			const logs = readdirSync(config.logs.dir).filter((f: string) => f.endsWith(".log"));
			console.log(`\n${pc.cyan("Sessions:")} ${logs.length} log file(s) found`);
		} else {
			console.log(`\n${pc.dim("No sessions yet.")}`);
		}
	},
});

function getVersion(): string {
	try {
		const pkgPath = resolvePath(new URL(".", import.meta.url).pathname, "../package.json");
		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };
		return pkg.version;
	} catch {
		return "0.0.0";
	}
}

export const main = defineCommand({
	meta: {
		name: "lisa",
		version: getVersion(),
		description:
			"Deterministic autonomous issue resolver — structured AI agent loop for Linear/Trello",
	},
	subCommands: { run, config, init, status },
});

async function runConfigWizard(): Promise<void> {
	banner();

	const providerLabels: Record<ProviderName, string> = {
		claude: "Claude Code",
		gemini: "Gemini CLI",
		opencode: "OpenCode",
	};

	const available = await getAvailableProviders();

	if (available.length === 0) {
		clack.log.error("No compatible AI providers found.");
		clack.log.info(
			`Install at least one of the following providers to continue:\n\n` +
				`  ${pc.bold("Claude Code")}   ${pc.dim("npm i -g @anthropic-ai/claude-code")}\n` +
				`  ${pc.bold("Gemini CLI")}    ${pc.dim("npm i -g @anthropic-ai/gemini-cli")}\n` +
				`  ${pc.bold("OpenCode")}      ${pc.dim("npm i -g opencode")}\n\n` +
				`After installing, run ${pc.cyan("lisa init")} again.`,
		);
		return process.exit(1);
	}

	let providerName: ProviderName;

	if (available.length === 1 && available[0]) {
		providerName = available[0].name;
		clack.log.info(`Found provider: ${pc.bold(providerLabels[providerName])}`);
	} else {
		const selected = await clack.select({
			message: "Which AI provider do you want to use?",
			options: available.map((p) => ({
				value: p.name,
				label: providerLabels[p.name],
			})),
		});
		if (clack.isCancel(selected)) return process.exit(0);
		providerName = selected as ProviderName;
	}

	const source = await clack.select({
		message: "Where do your issues live?",
		options: [
			{ value: "linear", label: "Linear" },
			{ value: "trello", label: "Trello" },
		],
	});
	if (clack.isCancel(source)) return process.exit(0);

	// Validate env vars for the selected source
	const missing = await getMissingEnvVars(source as SourceName);
	if (missing.length > 0) {
		const shell = process.env.SHELL?.includes("zsh") ? "~/.zshrc" : "~/.bashrc";
		clack.log.warning(
			`Missing environment variables:\n${missing.map((v) => `  ${pc.bold(v)}`).join("\n")}\n\nAdd them to your environment variables:\n${missing.map((v) => `  export ${v}="your-key-here"`).join("\n")}\n\nThen run: ${pc.cyan(`source ${shell}`)}`,
		);
	}

	// Detect GitHub method
	const githubMethod = await detectGitHubMethod();

	// --- Issue source config ---

	const teamAnswer = await clack.text({
		message: source === "linear" ? "Team?" : "Board?",
	});
	if (clack.isCancel(teamAnswer)) return process.exit(0);
	const team = teamAnswer as string;

	const labelAnswer = await clack.text({
		message: "Label to pick up?",
		initialValue: "ready",
	});
	if (clack.isCancel(labelAnswer)) return process.exit(0);
	const label = labelAnswer as string;

	let project: string;
	let pickFrom: string;
	let inProgress: string;
	let done: string;

	if (source === "trello") {
		const pickFromAnswer = await clack.text({
			message: "Pick up cards from which list?",
			initialValue: "Backlog",
		});
		if (clack.isCancel(pickFromAnswer)) return process.exit(0);
		pickFrom = pickFromAnswer as string;
		project = pickFrom;

		const inProgressAnswer = await clack.text({
			message: "Move to which column while working?",
			initialValue: "In Progress",
		});
		if (clack.isCancel(inProgressAnswer)) return process.exit(0);
		inProgress = inProgressAnswer as string;

		const doneAnswer = await clack.text({
			message: "Move to which column after PR?",
			initialValue: "Code Review",
		});
		if (clack.isCancel(doneAnswer)) return process.exit(0);
		done = doneAnswer as string;
	} else {
		const projectAnswer = await clack.text({
			message: "Project?",
		});
		if (clack.isCancel(projectAnswer)) return process.exit(0);
		project = projectAnswer as string;

		const pickFromAnswer = await clack.text({
			message: "Pick up issues from which status?",
			initialValue: "Backlog",
		});
		if (clack.isCancel(pickFromAnswer)) return process.exit(0);
		pickFrom = pickFromAnswer as string;

		const inProgressAnswer = await clack.text({
			message: "Move to which status while working?",
			initialValue: "In Progress",
		});
		if (clack.isCancel(inProgressAnswer)) return process.exit(0);
		inProgress = inProgressAnswer as string;

		const doneAnswer = await clack.text({
			message: "Move to which status after PR?",
			initialValue: "In Review",
		});
		if (clack.isCancel(doneAnswer)) return process.exit(0);
		done = doneAnswer as string;
	}

	// --- Git workflow ---

	const workflowAnswer = await clack.select({
		message: "How should Lisa work on issues?",
		options: [
			{ value: "branch", label: "Branch", hint: "creates branches in the current checkout" },
			{ value: "worktree", label: "Worktree", hint: "creates isolated worktrees per issue" },
		],
	});
	if (clack.isCancel(workflowAnswer)) return process.exit(0);
	const workflow = workflowAnswer as WorkflowMode;

	// Auto-detect repos
	const repos = await detectGitRepos();

	// Ask for base branch
	let baseBranch = "main";
	const cwd = process.cwd();

	if (repos.length === 0) {
		const detected = detectDefaultBranch(cwd);
		const branchAnswer = await clack.text({
			message: "Base branch?",
			initialValue: detected,
		});
		if (clack.isCancel(branchAnswer)) return process.exit(0);
		baseBranch = branchAnswer as string;
	} else {
		for (const repo of repos) {
			const repoPath = resolvePath(cwd, repo.path);
			const detected = detectDefaultBranch(repoPath);
			const branchAnswer = await clack.text({
				message: `Base branch for ${repo.name}?`,
				initialValue: detected,
			});
			if (clack.isCancel(branchAnswer)) return process.exit(0);
			repo.base_branch = branchAnswer as string;
		}
	}

	// Setup .worktrees gitignore if worktree mode
	if (workflow === "worktree") {
		if (repos.length === 0) {
			ensureWorktreeGitignore(cwd);
		} else {
			for (const repo of repos) {
				ensureWorktreeGitignore(resolvePath(cwd, repo.path));
			}
		}
		clack.log.info("Added .worktrees to .gitignore");
	}

	const cfg: LisaConfig = {
		provider: providerName,
		source: source as SourceName,
		source_config: {
			team,
			project,
			label,
			pick_from: pickFrom,
			in_progress: inProgress,
			done,
		},
		github: githubMethod,
		workflow,
		workspace: ".",
		base_branch: baseBranch,
		repos,
		loop: { cooldown: 10, max_sessions: 0 },
		logs: { dir: ".lisa/logs", format: "text" },
	};

	saveConfig(cfg);
	clack.outro(pc.green("Config saved to .lisa/config.yaml"));
}

async function detectGitHubMethod(): Promise<GitHubMethod> {
	const hasToken = !!process.env.GITHUB_TOKEN;
	const hasCli = await isGhCliAvailable();

	if (hasToken && hasCli) {
		const selected = await clack.select({
			message: "Both GitHub CLI and GITHUB_TOKEN detected. Which do you want to use?",
			options: [
				{ value: "cli", label: "GitHub CLI", hint: "gh" },
				{ value: "token", label: "GitHub API", hint: "GITHUB_TOKEN" },
			],
		});
		if (clack.isCancel(selected)) return process.exit(0);
		return selected as GitHubMethod;
	}

	if (hasCli) {
		clack.log.info("Using GitHub CLI for pull requests.");
		return "cli";
	}

	if (hasToken) {
		clack.log.info("Using GITHUB_TOKEN for pull requests.");
		return "token";
	}

	// Neither available — default to token (getMissingEnvVars already warns)
	return "token";
}

async function detectGitRepos(): Promise<RepoConfig[]> {
	const cwd = process.cwd();

	// If current directory is a git repo, no sub-repos needed
	if (existsSync(join(cwd, ".git"))) {
		clack.log.info(`Detected git repository in current directory.`);
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
		message: "Select the repos to include in the workspace:",
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

function detectDefaultBranch(repoPath: string): string {
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

function getGitRepoName(repoPath: string): string | null {
	try {
		const url = execSync("git remote get-url origin", { cwd: repoPath, encoding: "utf-8" }).trim();
		// Handle both HTTPS (https://github.com/org/repo.git) and SSH (git@github.com:org/repo.git)
		const match = url.match(/\/([^/]+?)(?:\.git)?$/) ?? url.match(/:([^/]+?)(?:\.git)?$/);
		return match?.[1] ?? null;
	} catch {
		return null;
	}
}

async function getMissingEnvVars(source: SourceName): Promise<string[]> {
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
	}

	return missing;
}

export function runCli(): void {
	runMain(main);
}
