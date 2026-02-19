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
import type { Effort, MatutoConfig, ProviderName, SourceName } from "./types.js";

const run = defineCommand({
	meta: { name: "run", description: "Run the agent loop" },
	args: {
		once: { type: "boolean", description: "Run a single iteration", default: false },
		limit: { type: "string", description: "Max number of issues to process", default: "0" },
		"dry-run": { type: "boolean", description: "Preview without executing", default: false },
		provider: { type: "string", description: "AI provider (claude, gemini, opencode)" },
		model: { type: "string", description: "Model ID override" },
		effort: { type: "string", description: "Effort level (low, medium, high)" },
		source: { type: "string", description: "Issue source (linear, trello, local)" },
		label: { type: "string", description: "Label to filter issues" },
	},
	async run({ args }) {
		banner();
		const config = loadConfig();
		const merged = mergeWithFlags(config, {
			provider: args.provider as ProviderName | undefined,
			model: args.model,
			effort: args.effort as Effort | undefined,
			source: args.source as SourceName | undefined,
			label: args.label,
		});

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
				console.error(pc.red("Usage: matuto config --set key=value"));
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
	meta: { name: "init", description: "Initialize matuto configuration" },
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
		console.log(`  Model:    ${pc.bold(config.model || "(provider default)")}`);
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
		name: "matuto",
		version: "0.1.0",
		description: "O cabra que resolve suas issues",
	},
	subCommands: { run, config, init, status },
});

async function runConfigWizard(): Promise<void> {
	clack.intro(pc.cyan("matuto — o cabra que resolve suas issues"));

	const provider = await clack.select({
		message: "Which AI provider do you want to use?",
		options: [
			{ value: "claude", label: "Claude Code", hint: "recommended" },
			{ value: "gemini", label: "Gemini CLI" },
			{ value: "opencode", label: "OpenCode" },
		],
	});
	if (clack.isCancel(provider)) return process.exit(0);

	const source = await clack.select({
		message: "Where do your issues live?",
		options: [
			{ value: "linear", label: "Linear" },
			{ value: "trello", label: "Trello" },
			{ value: "local", label: "Local", hint: ".matuto/issues/*.md" },
		],
	});
	if (clack.isCancel(source)) return process.exit(0);

	let team = "";
	let project = "";
	let label = "ready";

	if (source !== "local") {
		const teamAnswer = await clack.text({
			message: source === "linear" ? "Linear team name?" : "Trello board name?",
			initialValue: "Internal",
		});
		if (clack.isCancel(teamAnswer)) return process.exit(0);
		team = teamAnswer as string;

		const projectAnswer = await clack.text({
			message: source === "linear" ? "Project name?" : "Trello list name?",
			initialValue: "Zenixx",
		});
		if (clack.isCancel(projectAnswer)) return process.exit(0);
		project = projectAnswer as string;

		const labelAnswer = await clack.text({
			message: "Label to pick up?",
			initialValue: "ready",
		});
		if (clack.isCancel(labelAnswer)) return process.exit(0);
		label = labelAnswer as string;
	} else {
		clack.log.info("Issues dir: .matuto/issues/");
	}

	const cfg: MatutoConfig = {
		provider: provider as ProviderName,
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
		logs: { dir: ".matuto/logs", format: "text" },
	};

	saveConfig(cfg);
	clack.outro(pc.green("Config saved to .matuto/config.yaml"));
}

export function runCli(): void {
	runMain(main);
}
