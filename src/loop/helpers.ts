import { resolve } from "node:path";
import { execa } from "execa";
import * as logger from "../output/logger.js";
import type { LisaConfig } from "../types/index.js";
import { isLoopPaused } from "./state.js";

export function resolveProviderOptions(config: LisaConfig): { effort?: string } | undefined {
	const opts = config.provider_options?.[config.provider];
	if (!opts?.effort) return undefined;
	return { effort: opts.effort };
}

export function resolveBaseBranch(config: LisaConfig, repoPath: string): string {
	const workspace = resolve(config.workspace);
	const repo = config.repos.find((r) => resolve(workspace, r.path) === repoPath);
	return repo?.base_branch ?? config.base_branch;
}

export async function checkoutBaseBranches(config: LisaConfig, workspace: string): Promise<void> {
	const targets: { cwd: string; branch: string }[] = [
		{ cwd: workspace, branch: config.base_branch },
		...config.repos.map((r) => ({
			cwd: resolve(workspace, r.path),
			branch: r.base_branch,
		})),
	];

	for (const { cwd, branch } of targets) {
		try {
			await execa("git", ["checkout", branch], { cwd });
			logger.ok(`Checked out ${branch} in ${cwd}`);
		} catch (err) {
			logger.warn(
				`Could not checkout ${branch} in ${cwd}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitIfPaused(): Promise<void> {
	while (isLoopPaused()) {
		await sleep(500);
	}
}
