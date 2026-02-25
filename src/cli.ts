import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

import * as clack from "@clack/prompts";
import { defineCommand, runMain } from "citty";
import pc from "picocolors";
import { configExists, findConfigDir, loadConfig, mergeWithFlags, saveConfig } from "./config.js";
import { isGhCliAvailable } from "./git/github.js";
import { ensureWorktreeGitignore } from "./git/worktree.js";
import { runLoop } from "./loop.js";
import { banner, log, setOutputMode } from "./output/logger.js";
import { getAllProvidersWithAvailability } from "./providers/index.js";
import { createSource } from "./sources/index.js";
import type {
	GitHubMethod,
	Issue,
	LisaConfig,
	ProviderName,
	RepoConfig,
	SourceName,
	WorkflowMode,
} from "./types/index.js";

// Rate limit guard: prevents rapid-fire calls to the issue tracker API when
// the provider invokes multiple `lisa issue` commands in quick succession.
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const run = defineCommand({
	meta: { name: "run", description: "Run the agent loop" },
	args: {
		once: { type: "boolean", description: "Run a single iteration", default: false },
		limit: { type: "string", description: "Max number of issues to process", default: "0" },
		"dry-run": {
			type: "boolean",
			description: "Preview config without executing — recommended first step to verify setup",
			default: false,
		},
		issue: { type: "string", description: "Run a specific issue by identifier or URL" },
		provider: { type: "string", description: "AI provider (claude, gemini, opencode)" },
		source: { type: "string", description: "Issue source (linear, trello)" },
		label: { type: "string", description: "Label to filter issues" },
		github: { type: "string", description: "GitHub method: cli or token" },
		json: { type: "boolean", description: "Output as JSON lines", default: false },
		quiet: { type: "boolean", description: "Suppress non-essential output", default: false },
	},
	async run({ args }) {
		const isTUI = process.stdout.isTTY && !args.json && !args.quiet;

		if (args.json) setOutputMode("json");
		else if (args.quiet) setOutputMode("quiet");
		else if (isTUI) setOutputMode("tui");

		banner(); // no-op in tui mode since outputMode !== "default"

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

		if (isTUI) {
			const { render } = await import("ink");
			const { createElement } = await import("react");
			const { KanbanApp } = await import("./ui/kanban.js");
			render(createElement(KanbanApp, { config: merged }), { exitOnCtrlC: false });
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
			const existing = loadConfig();
			clack.log.info(
				`Existing config found — current values will be pre-filled. Edit what you need, keep the rest.`,
			);
			await runConfigWizard(existing);
		} else {
			await runConfigWizard();
		}
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

const CURSOR_FREE_PLAN_ERROR = "Free plans can only use Auto";

async function isCursorFreePlan(): Promise<boolean> {
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

const issueGet = defineCommand({
	meta: { name: "get", description: "Fetch full issue details as JSON" },
	args: {
		id: { type: "positional", required: true, description: "Issue ID (e.g. INT-123)" },
	},
	async run({ args }) {
		await sleep(1000);
		const configDir = findConfigDir();
		if (!configDir) {
			console.error(JSON.stringify({ error: "No .lisa/config.yaml found in directory tree" }));
			process.exit(1);
		}
		const config = loadConfig(configDir);
		const source = createSource(config.source);
		let issue: Issue | null;
		try {
			issue = await source.fetchIssueById(args.id);
		} catch (err) {
			console.error(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
			process.exit(1);
		}
		if (!issue) {
			console.error(JSON.stringify({ error: `Issue ${args.id} not found` }));
			process.exit(1);
		}
		console.log(JSON.stringify(issue));
	},
});

const issueDone = defineCommand({
	meta: { name: "done", description: "Complete an issue: attach PR, update status, remove label" },
	args: {
		id: { type: "positional", required: true, description: "Issue ID (e.g. INT-123)" },
		"pr-url": { type: "string", required: true, description: "Pull request URL" },
	},
	async run({ args }) {
		await sleep(1000);
		const configDir = findConfigDir();
		if (!configDir) {
			console.error(JSON.stringify({ error: "No .lisa/config.yaml found in directory tree" }));
			process.exit(1);
		}
		const config = loadConfig(configDir);
		const source = createSource(config.source);
		try {
			await source.attachPullRequest(args.id, args["pr-url"]);
			await source.completeIssue(args.id, config.source_config.done, config.source_config.label);
			console.log(JSON.stringify({ success: true, issueId: args.id, prUrl: args["pr-url"] }));
		} catch (err) {
			console.error(
				JSON.stringify({
					error: err instanceof Error ? err.message : String(err),
					issueId: args.id,
				}),
			);
			process.exit(1);
		}
	},
});

const issue = defineCommand({
	meta: { name: "issue", description: "Issue tracker operations for use inside worktrees" },
	subCommands: { get: issueGet, done: issueDone },
});

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

function fetchCursorModels(): string[] {
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

function fetchOpenCodeModels(): string[] {
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
				if (/^google\/gemini-2\.5-(pro|flash|flash-lite)$/.test(m)) return hasGoogle;
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

export const main = defineCommand({
	meta: {
		name: "lisa",
		version: getVersion(),
		description:
			"Deterministic autonomous issue resolver — structured AI agent loop for Linear/Trello",
	},
	subCommands: { run, config, init, status, issue },
});

async function runConfigWizard(existing?: LisaConfig): Promise<void> {
	clack.intro(
		pc.cyan(existing ? " lisa ♪  editing config " : " lisa ♪  autonomous issue resolver "),
	);

	const providerLabels: Record<ProviderName, string> = {
		claude: "Claude Code",
		gemini: "Gemini CLI",
		opencode: "OpenCode",
		copilot: "GitHub Copilot CLI",
		cursor: "Cursor Agent",
		goose: "Goose",
		aider: "Aider",
		codex: "OpenAI Codex",
	};

	const providerModels: Partial<Record<ProviderName, string[]>> = {
		claude: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5", "claude-sonnet-4-5"],
		gemini: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"],
		// opencode: populated dynamically below (fetchOpenCodeModels)
		copilot: ["claude-opus-4.6", "claude-sonnet-4.6", "claude-haiku-4.5", "gpt-5.2"],
		goose: ["claude-sonnet-4-5", "claude-opus-4-5", "claude-haiku-4-5"],
		aider: ["claude-opus-4-6", "claude-sonnet-4-5", "claude-haiku-4-5"],
		codex: ["gpt-5.1-codex-mini", "gpt-5.1-codex-max", "gpt-5.2-codex", "gpt-5.2", "gpt-5.3-codex"],
		// cursor: populated dynamically below (fetchCursorModels)
	};

	const allProviders = await getAllProvidersWithAvailability();
	const available = allProviders.filter((r) => r.available).map((r) => r.provider);

	if (available.length === 0) {
		clack.log.error("No AI provider found on your system.");
		clack.log.info(
			`Install at least one of the following and re-run ${pc.cyan("lisa init")}:\n\n` +
				`  ${pc.bold("Claude Code")}        ${pc.dim("npm i -g @anthropic-ai/claude-code")}\n` +
				`  ${pc.bold("Gemini CLI")}         ${pc.dim("npm i -g @google/gemini-cli")}\n` +
				`  ${pc.bold("OpenCode")}           ${pc.dim("npm i -g opencode")}\n` +
				`  ${pc.bold("GitHub Copilot CLI")} ${pc.dim("npm i -g @github/copilot-cli")}\n` +
				`  ${pc.bold("OpenAI Codex")}       ${pc.dim("npm i -g @openai/codex")}\n` +
				`  ${pc.bold("Goose")}              ${pc.dim("https://block.github.io/goose")}\n` +
				`  ${pc.bold("Aider")}              ${pc.dim("pip install aider-chat")}`,
		);
		return process.exit(1);
	}

	let providerName: ProviderName;

	if (available.length === 1 && available[0] && !existing) {
		providerName = available[0].name;
		clack.log.info(`Auto-detected ${pc.bold(providerLabels[providerName])} as your AI provider.`);
	} else {
		const selected = await clack.select({
			message: "Which AI provider should resolve your issues?",
			initialValue: existing?.provider,
			options: allProviders.map(({ provider, available: isAvailable }) => ({
				value: provider.name,
				label: providerLabels[provider.name],
				hint: isAvailable ? undefined : "not installed",
				disabled: !isAvailable,
			})),
		});
		if (clack.isCancel(selected)) return process.exit(0);
		providerName = selected as ProviderName;
	}

	let selectedModels: string[] = [];

	let availableModels = providerModels[providerName];

	if (providerName === "cursor") {
		const isFree = await isCursorFreePlan();
		if (isFree) {
			availableModels = ["auto"];
			clack.log.info("Cursor Free plan detected — only the 'auto' model is available.");
		} else {
			availableModels = fetchCursorModels();
		}
	} else if (providerName === "opencode") {
		const dynamic = fetchOpenCodeModels();
		availableModels =
			dynamic.length > 0
				? dynamic
				: [
						"anthropic/claude-opus-4-6",
						"anthropic/claude-sonnet-4-6",
						"anthropic/claude-haiku-4-5",
						"google/gemini-2.5-pro",
						"google/gemini-2.5-flash",
					];
	}

	if (availableModels && availableModels.length > 0) {
		const modelSelection = await clack.multiselect({
			message: "Which models should Lisa use? Select in order — first = primary, rest = fallbacks",
			initialValues: existing?.models?.filter((m) => availableModels.includes(m)) ?? [],
			options: availableModels.map((m) => ({
				value: m,
				label: m,
			})),
			required: false,
		});
		if (clack.isCancel(modelSelection)) return process.exit(0);
		selectedModels = (modelSelection as string[]) ?? [];
	}

	const source = await clack.select({
		message: "Where do your issues come from?",
		initialValue: existing?.source,
		options: [
			{ value: "linear", label: "Linear", apiHint: "GraphQL API", envVars: ["LINEAR_API_KEY"] },
			{
				value: "trello",
				label: "Trello",
				apiHint: "REST API",
				envVars: ["TRELLO_API_KEY", "TRELLO_TOKEN"],
			},
			{
				value: "github-issues",
				label: "GitHub Issues",
				apiHint: "REST API",
				envVars: ["GITHUB_TOKEN"],
			},
			{
				value: "gitlab-issues",
				label: "GitLab Issues",
				apiHint: "REST API",
				envVars: ["GITLAB_TOKEN"],
			},
			{ value: "plane", label: "Plane", apiHint: "REST API", envVars: ["PLANE_API_TOKEN"] },
			{
				value: "shortcut",
				label: "Shortcut",
				apiHint: "REST API",
				envVars: ["SHORTCUT_API_TOKEN"],
			},
			{
				value: "jira",
				label: "Jira",
				apiHint: "REST API",
				envVars: ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"],
			},
		].map(({ value, label, apiHint, envVars }) => {
			const missing = envVars.filter((v) => !process.env[v]);
			return {
				value,
				label,
				hint: missing.length > 0 ? `missing: ${missing.join(", ")}` : apiHint,
				disabled: missing.length > 0,
			};
		}),
	});
	if (clack.isCancel(source)) return process.exit(0);

	// Validate env vars for the selected source
	const missing = await getMissingEnvVars(source as SourceName);
	if (missing.length > 0) {
		const shell = process.env.SHELL?.includes("zsh") ? "~/.zshrc" : "~/.bashrc";
		clack.log.warning(
			`The following environment variables are missing:\n\n` +
				`${missing.map((v) => `  ${pc.bold(v)}`).join("\n")}\n\n` +
				`Add them to ${pc.cyan(shell)}:\n` +
				`${missing.map((v) => `  export ${v}="your-value-here"`).join("\n")}\n\n` +
				`Then reload: ${pc.cyan(`source ${shell}`)}`,
		);
	}

	// Detect GitHub method
	const githubMethod = await detectGitHubMethod();

	// --- Issue source config ---

	const teamAnswer = await clack.text({
		message:
			source === "linear"
				? "What is your Linear team name?"
				: source === "trello"
					? "What is your Trello board name?"
					: source === "jira"
						? "What is your Jira project key?"
						: "What is your team or project name?",
		initialValue: existing?.source_config.team ?? "",
		placeholder: source === "linear" ? "e.g. Engineering" : undefined,
	});
	if (clack.isCancel(teamAnswer)) return process.exit(0);
	const team = teamAnswer as string;

	const labelAnswer = await clack.text({
		message: "Which label marks issues as ready for the agent to pick up?",
		initialValue: existing?.source_config.label ?? "ready",
		placeholder: "e.g. ready, ai, lisa",
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
			initialValue: existing?.source_config.pick_from ?? "Backlog",
		});
		if (clack.isCancel(pickFromAnswer)) return process.exit(0);
		pickFrom = pickFromAnswer as string;
		project = pickFrom;

		const inProgressAnswer = await clack.text({
			message: "Move the card to which list while the agent is working?",
			initialValue: existing?.source_config.in_progress ?? "In Progress",
		});
		if (clack.isCancel(inProgressAnswer)) return process.exit(0);
		inProgress = inProgressAnswer as string;

		const doneAnswer = await clack.text({
			message: "Move the card to which list after the PR is created?",
			initialValue: existing?.source_config.done ?? "Code Review",
		});
		if (clack.isCancel(doneAnswer)) return process.exit(0);
		done = doneAnswer as string;
	} else {
		const projectAnswer = await clack.text({
			message:
				source === "linear"
					? "Which Linear project should Lisa work on? (leave empty for all team issues)"
					: "Which project should Lisa work on?",
			initialValue: existing?.source_config.project ?? "",
			placeholder: source === "linear" ? "e.g. Q1 Roadmap  (optional)" : undefined,
		});
		if (clack.isCancel(projectAnswer)) return process.exit(0);
		project = projectAnswer as string;

		const pickFromAnswer = await clack.text({
			message: "Pick up issues in which status?",
			initialValue: existing?.source_config.pick_from ?? "Backlog",
			placeholder: "e.g. Backlog, Todo",
		});
		if (clack.isCancel(pickFromAnswer)) return process.exit(0);
		pickFrom = pickFromAnswer as string;

		const inProgressAnswer = await clack.text({
			message: "Move to which status while the agent is working?",
			initialValue: existing?.source_config.in_progress ?? "In Progress",
		});
		if (clack.isCancel(inProgressAnswer)) return process.exit(0);
		inProgress = inProgressAnswer as string;

		const doneAnswer = await clack.text({
			message: "Move to which status after the PR is created?",
			initialValue: existing?.source_config.done ?? "In Review",
		});
		if (clack.isCancel(doneAnswer)) return process.exit(0);
		done = doneAnswer as string;
	}

	// --- Git workflow ---

	const workflowAnswer = await clack.select({
		message: "How should Lisa check out code for each issue?",
		initialValue: existing?.workflow,
		options: [
			{
				value: "worktree",
				label: "Worktree",
				hint: "isolated git worktree per issue — recommended",
			},
			{
				value: "branch",
				label: "Branch",
				hint: "new branch in the current checkout",
			},
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
		const detected = existing?.base_branch ?? detectDefaultBranch(cwd);
		const branchAnswer = await clack.text({
			message: "What is the base branch to branch off from?",
			initialValue: detected,
		});
		if (clack.isCancel(branchAnswer)) return process.exit(0);
		baseBranch = branchAnswer as string;
	} else {
		for (const repo of repos) {
			const repoPath = resolvePath(cwd, repo.path);
			const detected = detectDefaultBranch(repoPath);
			const branchAnswer = await clack.text({
				message: `Base branch for ${pc.bold(repo.name)}?`,
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
		clack.log.info("Added .worktrees/ to .gitignore");
	}

	const cfg: LisaConfig = {
		provider: providerName,
		...(selectedModels.length > 0 ? { models: selectedModels } : {}),
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
	clack.outro(
		`${pc.green("All set!")} Config saved to ${pc.cyan(".lisa/config.yaml")}\n` +
			`  Run ${pc.bold(pc.cyan("lisa run"))} to start resolving issues.`,
	);
}

async function detectGitHubMethod(): Promise<GitHubMethod> {
	const hasToken = !!process.env.GITHUB_TOKEN;
	const hasCli = await isGhCliAvailable();

	if (hasToken && hasCli) {
		const selected = await clack.select({
			message: "How should Lisa create pull requests?",
			options: [
				{ value: "cli", label: "GitHub CLI", hint: "uses `gh pr create` — recommended" },
				{ value: "token", label: "GitHub API", hint: "uses GITHUB_TOKEN directly" },
			],
		});
		if (clack.isCancel(selected)) return process.exit(0);
		return selected as GitHubMethod;
	}

	if (hasCli) {
		clack.log.info("Pull requests will be created using the GitHub CLI.");
		return "cli";
	}

	if (hasToken) {
		clack.log.info("Pull requests will be created using GITHUB_TOKEN.");
		return "token";
	}

	// Neither available — default to token (getMissingEnvVars already warns)
	return "token";
}

async function detectGitRepos(): Promise<RepoConfig[]> {
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

export function runCli(): void {
	runMain(main);
}
