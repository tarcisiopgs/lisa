import { defineCommand } from "citty";
import pc from "picocolors";
import { findConfigDir } from "../../config.js";
import { banner } from "../../output/logger.js";
import { listSessionRecords } from "../../session/state.js";

export const sessions = defineCommand({
	meta: { name: "sessions", description: "List active session states" },
	args: {
		json: { type: "boolean", description: "Output as JSON", default: false },
	},
	async run({ args }) {
		const workspace = findConfigDir() ?? process.cwd();
		const records = listSessionRecords(workspace);

		if (args.json) {
			console.log(JSON.stringify(records, null, 2));
			return;
		}

		banner();

		if (records.length === 0) {
			console.error(pc.dim("No active sessions."));
			return;
		}

		console.error(pc.cyan(`Active sessions: ${records.length}\n`));
		for (const r of records) {
			const stateColor =
				r.state === "done" || r.state === "approved"
					? pc.green
					: r.state === "failed" || r.state === "killed"
						? pc.red
						: pc.yellow;
			const attempts = `ci:${r.attempts.ci} review:${r.attempts.review} val:${r.attempts.validation}`;
			console.error(`  ${pc.bold(r.issueId)}  ${stateColor(r.state)}  ${pc.dim(attempts)}`);
			if (r.prUrl) console.error(`    ${pc.dim("PR:")} ${r.prUrl}`);
			if (r.branch) console.error(`    ${pc.dim("branch:")} ${r.branch}`);
		}
	},
});
