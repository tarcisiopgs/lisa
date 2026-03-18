import { existsSync, readdirSync } from "node:fs";
import { defineCommand } from "citty";
import pc from "picocolors";
import { formatLabels, loadConfig } from "../../config.js";
import { banner } from "../../output/logger.js";
import { getLogsDir } from "../../paths.js";

export const status = defineCommand({
	meta: { name: "status", description: "Show current config, session count, and log location" },
	async run() {
		banner();
		const config = loadConfig();
		const isLinear = config.source === "linear";
		console.log(pc.cyan("Configuration:"));
		console.log(`  Provider:    ${pc.bold(config.provider)}`);
		console.log(`  Source:      ${pc.bold(config.source)}`);
		console.log(`  Workflow:    ${pc.bold(config.workflow)}`);
		console.log(`  Label:       ${pc.bold(formatLabels(config.source_config))}`);
		console.log(`  Scope:       ${pc.bold(config.source_config.scope)}`);
		if (isLinear) {
			console.log(`  Project:     ${pc.bold(config.source_config.project)}`);
		}
		console.log(`  Pick from:   ${pc.bold(config.source_config.pick_from)}`);
		console.log(`  In progress: ${pc.bold(config.source_config.in_progress)}`);
		console.log(`  Done:        ${pc.bold(config.source_config.done)}`);
		const logsDir = getLogsDir(process.cwd());
		console.log(`  Logs:        ${pc.dim(logsDir)}`);

		// Count log files
		if (existsSync(logsDir)) {
			const logs = readdirSync(logsDir).filter((f: string) => f.endsWith(".log"));
			console.log(`\n${pc.cyan("Sessions:")} ${logs.length} log file(s) found`);
		} else {
			console.log(`\n${pc.dim("No sessions yet.")}`);
		}
	},
});
