import { defineCommand, runMain } from "citty";
import { config } from "./commands/config.js";
import { context } from "./commands/context.js";
import { feedback } from "./commands/feedback.js";
import { init } from "./commands/init.js";
import { issue } from "./commands/issue.js";
import { run } from "./commands/run.js";
import { status } from "./commands/status.js";
import { getVersion } from "./detection.js";

export const main = defineCommand({
	meta: {
		name: "lisa",
		version: getVersion(),
		description:
			"Deterministic autonomous issue resolver — structured AI agent loop for any issue tracker",
	},
	subCommands: { run, config, init, status, issue, feedback, context },
});

export function runCli(): void {
	runMain(main);
}

export { detectPlatformFromRemoteUrl } from "./detection.js";
