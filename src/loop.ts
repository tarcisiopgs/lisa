import { resolve } from "node:path";
import { appendFileSync } from "node:fs";
import * as logger from "./logger.js";
import { buildImplementPrompt } from "./prompt.js";
import { createProvider } from "./providers/index.js";
import { createSource } from "./sources/index.js";
import { createPullRequest, getRepoInfo } from "./github.js";
import {
	createWorktree,
	removeWorktree,
	generateBranchName,
	determineRepoPath,
	findBranchByIssueId,
} from "./worktree.js";
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
		`Starting loop (provider: ${config.provider}, source: ${config.source}, label: ${config.source_config.label}, workflow: ${config.workflow})`,
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
			logger.log(`[dry-run] Workflow mode: ${config.workflow}`);
			logger.log("[dry-run] Then implement, push, create PR, and update issue status");
			break;
		}

		let issue: Awaited<ReturnType<typeof source.fetchNextIssue>>;
		try {
			issue = await source.fetchNextIssue(config.source_config);
		} catch (err) {
			logger.error(`Failed to fetch issues: ${err instanceof Error ? err.message : String(err)}`);
			if (opts.once) break;
			await sleep(config.loop.cooldown * 1000);
			continue;
		}

		if (!issue) {
			logger.warn(
				`No issues with label '${config.source_config.label}' found. Sleeping ${config.loop.cooldown}s...`,
			);
			if (opts.once) break;
			await sleep(config.loop.cooldown * 1000);
			continue;
		}

		logger.ok(`Picked up: ${issue.id} — ${issue.title}`);

		// Move issue to in-progress status before starting work
		try {
			const inProgress = config.source_config.in_progress;
			await source.updateStatus(issue.id, inProgress);
			logger.ok(`Moved ${issue.id} to "${inProgress}"`);
		} catch (err) {
			logger.warn(`Failed to update status: ${err instanceof Error ? err.message : String(err)}`);
		}

		const prUrl = config.workflow === "worktree"
			? await runWorktreeSession(config, issue, logFile, session)
			: await runBranchSession(config, issue, logFile, session);

		// Attach PR link to issue card
		if (prUrl) {
			try {
				await source.attachPullRequest(issue.id, prUrl);
				logger.ok(`Attached PR to ${issue.id}`);
			} catch (err) {
				logger.warn(`Failed to attach PR: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		// Update issue status + remove label (shared by both modes)
		try {
			const doneStatus = config.source_config.done;
			await source.updateStatus(issue.id, doneStatus);
			logger.ok(`Updated ${issue.id} status to "${doneStatus}"`);
		} catch (err) {
			logger.error(`Failed to update status: ${err instanceof Error ? err.message : String(err)}`);
		}

		try {
			await source.removeLabel(issue.id, config.source_config.label);
			logger.ok(`Removed label "${config.source_config.label}" from ${issue.id}`);
		} catch (err) {
			logger.error(`Failed to remove label: ${err instanceof Error ? err.message : String(err)}`);
		}

		if (opts.once) {
			logger.log("Single iteration mode. Exiting.");
			break;
		}

		logger.log(`Cooling down ${config.loop.cooldown}s before next issue...`);
		await sleep(config.loop.cooldown * 1000);
	}

	logger.ok(`lisa finished. ${session} session(s) run.`);
}

function resolveBaseBranch(config: LisaConfig, repoPath: string): string {
	const workspace = resolve(config.workspace);
	const repo = config.repos.find((r) => resolve(workspace, r.path) === repoPath);
	return repo?.base_branch ?? config.base_branch;
}

async function runWorktreeSession(
	config: LisaConfig,
	issue: { id: string; title: string; url: string; description: string; repo?: string },
	logFile: string,
	session: number,
): Promise<string | undefined> {
	const provider = createProvider(config.provider);
	const workspace = resolve(config.workspace);

	// Determine target repo root
	const repoPath = determineRepoPath(config.repos, issue, workspace) ?? workspace;

	const defaultBranch = resolveBaseBranch(config, repoPath);
	const branchName = generateBranchName(issue.id, issue.title);

	logger.log(`Creating worktree for ${branchName} (base: ${defaultBranch})...`);

	let worktreePath: string;
	try {
		worktreePath = await createWorktree(repoPath, branchName, defaultBranch);
	} catch (err) {
		logger.error(`Failed to create worktree: ${err instanceof Error ? err.message : String(err)}`);
		return;
	}

	logger.ok(`Worktree created at ${worktreePath}`);

	const prompt = buildImplementPrompt(issue, config);
	logger.log(`Implementing in worktree... (log: ${logFile})`);
	logger.initLogFile(logFile);

	const result = await provider.run(prompt, { logFile, cwd: worktreePath });

	try {
		appendFileSync(logFile, `\n${"=".repeat(80)}\nFull output:\n${result.output}\n`);
	} catch {
		// Ignore log write errors
	}

	if (!result.success) {
		logger.error(`Session ${session} failed for ${issue.id}. Check ${logFile}`);
		await cleanupWorktree(repoPath, worktreePath);
		return undefined;
	}

	// Create PR from worktree
	let prUrl: string | undefined;
	try {
		const repoInfo = await getRepoInfo(worktreePath);
		const pr = await createPullRequest({
			owner: repoInfo.owner,
			repo: repoInfo.repo,
			head: branchName,
			base: defaultBranch,
			title: issue.title,
			body: `Closes ${issue.url}\n\nImplemented by [lisa](https://github.com/tarcisiopgs/lisa).`,
		}, config.github);
		logger.ok(`PR created: ${pr.html_url}`);
		prUrl = pr.html_url;
	} catch (err) {
		logger.error(`Failed to create PR: ${err instanceof Error ? err.message : String(err)}`);
	}

	await cleanupWorktree(repoPath, worktreePath);

	logger.ok(`Session ${session} complete for ${issue.id}`);
	return prUrl;
}

async function runBranchSession(
	config: LisaConfig,
	issue: { id: string; title: string; url: string; description: string; repo?: string },
	logFile: string,
	session: number,
): Promise<string | undefined> {
	const provider = createProvider(config.provider);
	const prompt = buildImplementPrompt(issue, config);
	const workspace = resolve(config.workspace);

	logger.log(`Implementing... (log: ${logFile})`);
	logger.initLogFile(logFile);

	const result = await provider.run(prompt, { logFile, cwd: workspace });

	try {
		appendFileSync(logFile, `\n${"=".repeat(80)}\nFull output:\n${result.output}\n`);
	} catch {
		// Ignore log write errors
	}

	if (!result.success) {
		logger.error(`Session ${session} failed for ${issue.id}. Check ${logFile}`);
		return undefined;
	}

	// In multi-repo workspaces, find the repo the agent worked in
	const repoPath = determineRepoPath(config.repos, issue, workspace) ?? workspace;

	const baseBranch = resolveBaseBranch(config, repoPath);

	let prUrl: string | undefined;
	try {
		const repoInfo = await getRepoInfo(repoPath);
		let headBranch = repoInfo.branch;

		// Agent may have switched back to the default branch after pushing —
		// find the feature branch by matching the issue ID in branch names
		if (headBranch === baseBranch) {
			const featureBranch = await findBranchByIssueId(repoPath, issue.id);
			if (featureBranch) {
				headBranch = featureBranch;
			}
		}

		const pr = await createPullRequest({
			owner: repoInfo.owner,
			repo: repoInfo.repo,
			head: headBranch,
			base: baseBranch,
			title: issue.title,
			body: `Closes ${issue.url}\n\nImplemented by [lisa](https://github.com/tarcisiopgs/lisa).`,
		}, config.github);
		logger.ok(`PR created: ${pr.html_url}`);
		prUrl = pr.html_url;
	} catch (err) {
		logger.error(`Failed to create PR: ${err instanceof Error ? err.message : String(err)}`);
	}

	logger.ok(`Session ${session} complete for ${issue.id}`);
	return prUrl;
}

async function cleanupWorktree(repoRoot: string, worktreePath: string): Promise<void> {
	try {
		await removeWorktree(repoRoot, worktreePath);
		logger.log("Worktree cleaned up.");
	} catch (err) {
		logger.warn(`Failed to clean up worktree: ${err instanceof Error ? err.message : String(err)}`);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
