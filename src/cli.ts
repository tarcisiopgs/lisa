import { defineCommand, runMain } from "citty";
import * as clack from "@clack/prompts";
import pc from "picocolors";
import {
	configExists,
	loadConfig,
	mergeWithFlags,
	saveConfig,
} from "./config.js";
import { banner, log } from "./logger.js";
import { runLoop } from "./loop.js";
import { isGhCliAvailable } from "./github.js";
import { getAvailableProviders } from "./providers/index.js";
import type { LisaConfig, ProviderName, SourceName } from "./types.js";

const run = defineCommand({
	meta: { name: "run", description: "Run the agent loop" },
	args: {
		once: { type: "boolean", description: "Run a single iteration", default: false },
		limit: { type: "string", description: "Max number of issues to process", default: "0" },
		"dry-run": { type: "boolean", description: "Preview without executing", default: false },
		provider: { type: "string", description: "AI provider (claude, gemini, opencode)" },
		source: { type: "string", description: "Issue source (linear, trello)" },
		label: { type: "string", description: "Label to filter issues" },
	},
	async run({ args }) {
		banner();
		const config = loadConfig();
		const merged = mergeWithFlags(config, {
			provider: args.provider as ProviderName | undefined,
			source: args.source as SourceName | undefined,
			label: args.label,
		});

		// Validate env vars before running
		const missingVars = await getMissingEnvVars(merged.source);
		if (missingVars.length > 0) {
			const shell = process.env.SHELL?.includes("zsh") ? "~/.zshrc" : "~/.bashrc";
			console.error(pc.red(`Missing required environment variables:\n${missingVars.map((v) => `  ${v}`).join("\n")}`));
			console.error(pc.dim(`\nAdd them to your ${shell} and run: source ${shell}`));
			process.exit(1);
		}

		await runLoop(merged, {
			once: args.once,
			limit: Number.parseInt(args.limit, 10),
			dryRun: args["dry-run"],
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
				console.error(pc.red("Usage: lisa-loop config --set key=value"));
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
	meta: { name: "init", description: "Initialize lisa-loop configuration" },
	async run() {
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
		console.log(pc.cyan("Configuration:"));
		console.log(`  Provider: ${pc.bold(config.provider)}`);
		console.log(`  Source:   ${pc.bold(config.source)}`);
		console.log(`  Label:    ${pc.bold(config.source_config.label)}`);
		console.log(`  Team:     ${pc.bold(config.source_config.team)}`);
		console.log(`  Project:  ${pc.bold(config.source_config.project)}`);
		console.log(`  Logs:     ${pc.dim(config.logs.dir)}`);

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

export const main = defineCommand({
	meta: {
		name: "lisa-loop",
		version: "0.1.0",
		description: "Autonomous issue resolver — AI agent loop for Linear/Trello",
	},
	subCommands: { run, config, init, status },
});

async function runConfigWizard(): Promise<void> {
	clack.intro(pc.cyan("lisa-loop — autonomous issue resolver"));

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
			`After installing, run ${pc.cyan("lisa-loop init")} again.`,
		);
		return process.exit(1);
	}

	let providerName: ProviderName;

	if (available.length === 1) {
		providerName = available[0]!.name;
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

	const teamAnswer = await clack.text({
		message: source === "linear" ? "Linear team name?" : "Trello board name?",
		initialValue: "Internal",
	});
	if (clack.isCancel(teamAnswer)) return process.exit(0);
	const team = teamAnswer as string;

	const projectAnswer = await clack.text({
		message: source === "linear" ? "Project name?" : "Trello list name?",
		initialValue: "Zenixx",
	});
	if (clack.isCancel(projectAnswer)) return process.exit(0);
	const project = projectAnswer as string;

	const labelAnswer = await clack.text({
		message: "Label to pick up?",
		initialValue: "ready",
	});
	if (clack.isCancel(labelAnswer)) return process.exit(0);
	const label = labelAnswer as string;

	const cfg: LisaConfig = {
		provider: providerName,
		source: source as SourceName,
		source_config: {
			team,
			project,
			label,
			status: "Backlog",
		},
		workspace: ".",
		repos: [],
		loop: { cooldown: 10, max_sessions: 0 },
		logs: { dir: ".lisa-loop/logs", format: "text" },
	};

	saveConfig(cfg);
	clack.outro(pc.green("Config saved to .lisa-loop/config.yaml"));
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
