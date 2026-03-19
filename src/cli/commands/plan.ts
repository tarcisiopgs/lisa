import { defineCommand } from "citty";
import { findConfigDir, loadConfig } from "../../config.js";
import { formatError } from "../../errors.js";
import { runPlan } from "../../plan/index.js";
import { CliError } from "../error.js";

export const plan = defineCommand({
	meta: {
		name: "plan",
		description:
			'Decompose a goal into atomic issues using AI\n\n  Examples:\n    lisa plan "Add rate limiting to API"\n    lisa plan --issue EPIC-123\n    lisa plan --continue',
	},
	args: {
		goal: {
			type: "positional",
			required: false,
			description: "Goal description (text)",
		},
		issue: {
			type: "string",
			required: false,
			description: "Existing issue ID to decompose",
		},
		continue: {
			type: "boolean",
			required: false,
			description: "Resume the most recent interrupted plan",
		},
		json: {
			type: "boolean",
			required: false,
			description: "Output plan as JSON (non-interactive)",
		},
	},
	async run({ args }) {
		const configDir = findConfigDir();
		if (!configDir) {
			throw new CliError("No .lisa/config.yaml found. Run `lisa init` first.");
		}
		const config = loadConfig(configDir);

		try {
			await runPlan({
				config,
				goal: args.goal as string | undefined,
				issueId: args.issue as string | undefined,
				continueLatest: !!args.continue,
				jsonOutput: !!args.json,
			});
		} catch (err) {
			if (err instanceof CliError) throw err;
			throw new CliError(formatError(err));
		}
	},
});
