import * as clack from "@clack/prompts";
import { defineCommand } from "citty";
import pc from "picocolors";
import { configExists, loadConfig } from "../../config.js";
import { getCachedUpdateInfo } from "../../version.js";
import { runConfigWizard } from "../wizard.js";

export const init = defineCommand({
	meta: { name: "init", description: "Initialize lisa configuration" },
	async run() {
		if (!process.stdin.isTTY) {
			console.error(
				pc.red("Interactive mode requires a TTY. Cannot run init in non-interactive environments."),
			);
			process.exit(1);
		}

		const updateInfo = getCachedUpdateInfo();
		if (updateInfo) {
			clack.log.warning(
				`Update available: ${pc.dim(updateInfo.currentVersion)} → ${pc.green(pc.bold(updateInfo.latestVersion))}\n  Run ${pc.cyan("npm i -g @tarcisiopgs/lisa")} to update`,
			);
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
