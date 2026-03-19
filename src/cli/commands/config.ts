import { defineCommand } from "citty";
import pc from "picocolors";
import { loadConfig, saveConfig } from "../../config.js";
import { log } from "../../output/logger.js";
import { CliError } from "../error.js";
import { runConfigWizard } from "../wizard.js";

export const config = defineCommand({
	meta: {
		name: "config",
		description:
			"Show, edit, or reconfigure .lisa/config.yaml\n\n  Examples:\n    lisa config --show                 Print current configuration\n    lisa config --show --json          Output config as JSON\n    lisa config --set provider=gemini  Change a config value\n    lisa config                        Open interactive wizard",
	},
	args: {
		show: { type: "boolean", description: "Show current config", default: false },
		set: { type: "string", description: "Set a config value (key=value)" },
		json: { type: "boolean", description: "Output machine-readable JSON", default: false },
	},
	async run({ args }) {
		if (args.show) {
			const cfg = loadConfig();
			if (args.json) {
				console.log(JSON.stringify(cfg, null, 2));
			} else {
				console.log(pc.cyan("\nCurrent configuration:\n"));
				console.log(JSON.stringify(cfg, null, 2));
			}
			return;
		}

		if (args.set) {
			const [key, value] = args.set.split("=");
			if (!key || !value) {
				console.error(pc.red("Usage: lisa config --set key=value"));
				throw new CliError("Invalid --set format. Expected key=value.");
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
