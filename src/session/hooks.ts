import { spawn } from "node:child_process";
import * as logger from "../output/logger.js";
import type { HooksConfig } from "../types/index.js";

export type HookName = "before_run" | "after_run" | "after_create" | "before_remove";

export interface HookResult {
	success: boolean;
	output: string;
}

const DEFAULT_HOOK_TIMEOUT = 60_000;

/**
 * Runs a single lifecycle hook command in the given working directory.
 * Returns { success, output }. Rejects only on internal errors, not on
 * non-zero exit codes (those return success: false).
 */
export function runHook(
	hookName: HookName,
	command: string,
	cwd: string,
	env?: Record<string, string>,
	timeoutMs?: number,
): Promise<HookResult> {
	const timeout = timeoutMs ?? DEFAULT_HOOK_TIMEOUT;

	return new Promise((resolve) => {
		const proc = spawn("sh", ["-c", command], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, ...env },
		});

		let output = "";
		let killed = false;

		const timer = setTimeout(() => {
			killed = true;
			proc.kill("SIGTERM");
			setTimeout(() => {
				try {
					proc.kill("SIGKILL");
				} catch {}
			}, 1_000);
		}, timeout);

		proc.stdout?.on("data", (data: Buffer) => {
			output += data.toString();
		});
		proc.stderr?.on("data", (data: Buffer) => {
			output += data.toString();
		});

		proc.on("close", (code) => {
			clearTimeout(timer);
			if (killed) {
				resolve({
					success: false,
					output: `${output}\n[lisa-hooks] Hook "${hookName}" timed out after ${timeout}ms`,
				});
			} else {
				resolve({ success: code === 0, output });
			}
		});

		proc.on("error", (err) => {
			clearTimeout(timer);
			resolve({ success: false, output: `Hook spawn error: ${err.message}` });
		});
	});
}

/**
 * Runs a lifecycle hook if configured. Returns true if the hook succeeded
 * or was not configured (no-op). Returns false if the hook failed.
 *
 * `critical` hooks (before_run, after_create) log errors and return false.
 * Non-critical hooks (after_run, before_remove) log warnings and return true.
 */
export async function executeHook(
	hookName: HookName,
	hooks: HooksConfig | undefined,
	cwd: string,
	issueEnv: Record<string, string>,
): Promise<boolean> {
	if (!hooks) return true;

	const command = hooks[hookName];
	if (!command) return true;

	const critical = hookName === "before_run" || hookName === "after_create";

	logger.log(`Running hook "${hookName}": ${command}`);
	const result = await runHook(hookName, command, cwd, issueEnv, hooks.timeout);

	if (!result.success) {
		const trimmed = result.output.trim().slice(-500);
		if (critical) {
			logger.error(`Hook "${hookName}" failed:\n${trimmed}`);
			return false;
		}
		logger.warn(`Hook "${hookName}" failed (non-critical):\n${trimmed}`);
	}

	return true;
}

/**
 * Builds the environment variables injected into every hook.
 */
export function buildHookEnv(
	issueId: string,
	issueTitle: string,
	branch: string,
	workspace: string,
): Record<string, string> {
	return {
		LISA_ISSUE_ID: issueId,
		LISA_ISSUE_TITLE: issueTitle,
		LISA_BRANCH: branch,
		LISA_WORKSPACE: workspace,
	};
}
