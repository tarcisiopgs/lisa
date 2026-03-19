import { defineCommand, runMain } from "citty";
import { config } from "./commands/config.js";
import { context } from "./commands/context.js";
import { doctor } from "./commands/doctor.js";
import { feedback } from "./commands/feedback.js";
import { init } from "./commands/init.js";
import { issue } from "./commands/issue.js";
import { plan } from "./commands/plan.js";
import { run } from "./commands/run.js";
import { status } from "./commands/status.js";
import { getVersion } from "./detection.js";

export const main = defineCommand({
	meta: {
		name: "lisa",
		version: getVersion(),
		description:
			"Deterministic autonomous issue resolver — structured AI agent loop for any issue tracker\n\n  Docs: https://github.com/tarcisiopgs/lisa\n  Bugs: https://github.com/tarcisiopgs/lisa/issues",
	},
	subCommands: { run, plan, config, init, status, issue, feedback, context, doctor },
});

export function runCli(): void {
	runMain(main);
}

export { detectPlatformFromRemoteUrl } from "./detection.js";
