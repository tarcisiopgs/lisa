import { resolve } from "node:path";
import { appendFileSync } from "node:fs";
import * as logger from "./logger.js";
import { buildImplementPrompt, buildLocalImplementPrompt } from "./prompt.js";
import { createProvider } from "./providers/index.js";
import { createSource } from "./sources/index.js";
import type { MatutoConfig } from "./types.js";

export interface LoopOptions {
	once: boolean;
	limit: number;
	dryRun: boolean;
}

export async function runLoop(config: MatutoConfig, opts: LoopOptions): Promise<void> {
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

		if (opts.dryRun) {
			if (source.fetchNextLocal) {
				logger.log(`[dry-run] Would pick next local issue from .matuto/issues/`);
			} else {
				logger.log(`[dry-run] Would pick issue from ${config.source} (${config.source_config.team}/${config.source_config.project})`);
			}
			logger.log("[dry-run] Then implement and open PR");
			break;
		}

		// Pick issue — local source bypasses provider
		let issueId: string | null;
		let prompt: string;

		if (source.fetchNextLocal) {
			logger.log("Scanning local issues...");
			const issue = await source.fetchNextLocal(config.workspace);

			if (!issue) {
				logger.warn("No local issues found in .matuto/issues/. Sleeping...");
				if (opts.once) break;
				await sleep(config.loop.cooldown * 1000);
				continue;
			}

			issueId = issue.id;
			prompt = buildLocalImplementPrompt(issue, config);
		} else {
			logger.log(`Asking ${config.provider} to pick next '${config.source_config.label}' issue...`);
			issueId = await provider.pickIssue(source, config);

			if (!issueId) {
				logger.warn(
					`No issues with label '${config.source_config.label}' found. Sleeping ${config.loop.cooldown}s...`,
				);
				if (opts.once) break;
				await sleep(config.loop.cooldown * 1000);
				continue;
			}

			prompt = buildImplementPrompt(issueId, config);
		}

		logger.ok(`Picked up: ${issueId}`);
		logger.log(`Implementing... (log: ${logFile})`);
		logger.initLogFile(logFile);

		const workspace = resolve(config.workspace);

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

		if (result.success) {
			logger.ok(
				`Session ${session} complete for ${issueId} (${formatDuration(result.duration)})`,
			);

			// Post-processing: mark done if source supports it
			if (source.markDone) {
				await source.markDone(issueId, config.workspace);
				logger.log(`Moved ${issueId} to done/`);
			}
		} else {
			logger.error(
				`Session ${session} failed for ${issueId}. Check ${logFile}`,
			);
		}

		if (opts.once) {
			logger.log("Single iteration mode. Exiting.");
			break;
		}

		logger.log(`Cooling down ${config.loop.cooldown}s before next issue...`);
		await sleep(config.loop.cooldown * 1000);
	}

	logger.ok(`matuto finished. ${session} session(s) run.`);
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
