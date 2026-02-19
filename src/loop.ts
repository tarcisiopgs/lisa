import { resolve } from "node:path";
import { appendFileSync } from "node:fs";
import * as logger from "./logger.js";
import { buildImplementPrompt } from "./prompt.js";
import { createProvider } from "./providers/index.js";
import { createSource } from "./sources/index.js";
import { createPullRequest, getRepoInfo } from "./github.js";
import type { LisaConfig } from "./types.js";

export interface LoopOptions {
	once: boolean;
	limit: number;
	dryRun: boolean;
}

export async function runLoop(config: LisaConfig, opts: LoopOptions): Promise<void> {
	const provider = createProvider(config.provider);
	const source = createSource(config.source);

	const available = await provider.isAvailable();
	if (!available) {
		logger.error(`Provider "${config.provider}" is not installed or not in PATH.`);
		process.exit(1);
	}

	logger.log(
		`Starting loop (provider: ${config.provider}, model: ${config.model}, source: ${config.source}, label: ${config.source_config.label})`,
	);

	let session = 0;

	while (true) {
		session++;

		if (opts.limit > 0 && session > opts.limit) {
			logger.ok(`Reached limit of ${opts.limit} issues. Stopping.`);
			break;
		}

		const timestamp = new Date().toISOString().replace(/[:.]/g, "-").substring(0, 19);
		const logFile = resolve(config.logs.dir, `session_${session}_${timestamp}.log`);

		logger.divider(session);

		// 1. Fetch next issue via API
		logger.log(`Fetching next '${config.source_config.label}' issue from ${config.source}...`);

		if (opts.dryRun) {
			logger.log(`[dry-run] Would fetch issue from ${config.source} (${config.source_config.team}/${config.source_config.project})`);
			logger.log("[dry-run] Then implement, push, create PR, and update issue status");
			break;
		}

		const issue = await source.fetchNextIssue(config.source_config);

		if (!issue) {
			logger.warn(
				`No issues with label '${config.source_config.label}' found. Sleeping ${config.loop.cooldown}s...`,
			);
			if (opts.once) break;
			await sleep(config.loop.cooldown * 1000);
			continue;
		}

		logger.ok(`Picked up: ${issue.id} — ${issue.title}`);

		// 2. Build prompt with issue data inline
		const prompt = buildImplementPrompt(issue, config);

		logger.log(`Implementing... (log: ${logFile})`);
		logger.initLogFile(logFile);

		const workspace = resolve(config.workspace);

		// 3. Run the AI agent to implement + commit + push
		const result = await provider.run(prompt, {
			model: config.model || "",
			effort: config.effort || "medium",
			logFile,
			cwd: workspace,
		});

		// Save full output to log file
		try {
			appendFileSync(logFile, `\n${"=".repeat(80)}\nFull output:\n${result.output}\n`);
		} catch {
			// Ignore log write errors
		}

		if (!result.success) {
			logger.error(`Session ${session} failed for ${issue.id}. Check ${logFile}`);
			if (opts.once) break;
			await sleep(config.loop.cooldown * 1000);
			continue;
		}

		// 4. Create PR via GitHub API
		try {
			const repoInfo = await getRepoInfo(workspace);
			const pr = await createPullRequest({
				owner: repoInfo.owner,
				repo: repoInfo.repo,
				head: repoInfo.branch,
				base: repoInfo.defaultBranch,
				title: issue.title,
				body: `Closes ${issue.url}\n\nImplemented by lisa-loop.`,
			});
			logger.ok(`PR created: ${pr.html_url}`);
		} catch (err) {
			logger.error(`Failed to create PR: ${err instanceof Error ? err.message : String(err)}`);
		}

		// 5. Update issue status via API
		try {
			await source.updateStatus(issue.id, "In Review");
			logger.ok(`Updated ${issue.id} status to "In Review"`);
		} catch (err) {
			logger.error(`Failed to update status: ${err instanceof Error ? err.message : String(err)}`);
		}

		// 6. Remove label via API
		try {
			await source.removeLabel(issue.id, config.source_config.label);
			logger.ok(`Removed label "${config.source_config.label}" from ${issue.id}`);
		} catch (err) {
			logger.error(`Failed to remove label: ${err instanceof Error ? err.message : String(err)}`);
		}

		logger.ok(
			`Session ${session} complete for ${issue.id} (${formatDuration(result.duration)})`,
		);

		if (opts.once) {
			logger.log("Single iteration mode. Exiting.");
			break;
		}

		logger.log(`Cooling down ${config.loop.cooldown}s before next issue...`);
		await sleep(config.loop.cooldown * 1000);
	}

	logger.ok(`lisa-loop finished. ${session} session(s) run.`);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDuration(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	const remaining = seconds % 60;
	if (minutes > 0) return `${minutes}m ${remaining}s`;
	return `${seconds}s`;
}
