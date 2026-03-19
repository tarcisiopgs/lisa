import { defineCommand } from "citty";
import { findConfigDir, getRemoveLabel, loadConfig } from "../../config.js";
import { formatError } from "../../errors.js";
import { createSource } from "../../sources/index.js";
import type { Issue } from "../../types/index.js";
import { CliError } from "../error.js";

// Rate limit guard: prevents rapid-fire calls to the issue tracker API when
// the provider invokes multiple `lisa issue` commands in quick succession.
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
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
			throw new CliError("No .lisa/config.yaml found in directory tree");
		}
		const config = loadConfig(configDir);
		const source = createSource(config.source);
		let issue: Issue | null;
		try {
			issue = await source.fetchIssueById(args.id);
		} catch (err) {
			console.error(JSON.stringify({ error: formatError(err) }));
			throw new CliError(formatError(err));
		}
		if (!issue) {
			console.error(JSON.stringify({ error: `Issue ${args.id} not found` }));
			throw new CliError(`Issue ${args.id} not found`);
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
			throw new CliError("No .lisa/config.yaml found in directory tree");
		}
		const config = loadConfig(configDir);
		const source = createSource(config.source);
		try {
			await source.attachPullRequest(args.id, args["pr-url"]);
			await source.completeIssue(
				args.id,
				config.source_config.done,
				getRemoveLabel(config.source_config),
			);
			console.log(JSON.stringify({ success: true, issueId: args.id, prUrl: args["pr-url"] }));
		} catch (err) {
			console.error(
				JSON.stringify({
					error: formatError(err),
					issueId: args.id,
				}),
			);
			throw new CliError(formatError(err));
		}
	},
});

export const issue = defineCommand({
	meta: {
		name: "issue",
		description: "Issue tracker operations for use inside worktrees",
		hidden: true,
	},
	subCommands: { get: issueGet, done: issueDone },
});
