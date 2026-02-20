import type { ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { OverseerConfig } from "./types.js";

const execFileAsync = promisify(execFile);

export const STUCK_MESSAGE =
	"\n[lisa-overseer] Provider killed: no git changes detected within the stuck threshold. Eligible for fallback.\n";

export interface OverseerHandle {
	stop(): void;
	wasKilled(): boolean;
}

export async function getGitSnapshot(cwd: string): Promise<string> {
	try {
		const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
			cwd,
			timeout: 10_000,
		});
		return stdout;
	} catch {
		return "";
	}
}

export function startOverseer(
	proc: ChildProcess,
	cwd: string,
	config: OverseerConfig,
	getSnapshot: (cwd: string) => Promise<string> = getGitSnapshot,
): OverseerHandle {
	if (!config.enabled) {
		return {
			stop() {},
			wasKilled() {
				return false;
			},
		};
	}

	let killed = false;
	let lastSnapshot: string | undefined;
	let lastChangeTime = Date.now();
	let timer: ReturnType<typeof setInterval> | null = null;

	const check = async () => {
		if (killed) return;

		try {
			const snapshot = await getSnapshot(cwd);

			if (lastSnapshot === undefined) {
				// First check — establish baseline and start idle timer
				lastSnapshot = snapshot;
				lastChangeTime = Date.now();
				return;
			}

			if (snapshot !== lastSnapshot) {
				// Progress detected — reset idle timer
				lastSnapshot = snapshot;
				lastChangeTime = Date.now();
				return;
			}

			// No change since last snapshot — check if stuck threshold exceeded
			const idleMs = Date.now() - lastChangeTime;
			if (idleMs >= config.stuck_threshold * 1000) {
				killed = true;
				if (timer) {
					clearInterval(timer);
					timer = null;
				}
				proc.kill("SIGTERM");
			}
		} catch {
			// Ignore monitoring errors — do not interrupt the provider
		}
	};

	timer = setInterval(check, config.check_interval * 1000);

	return {
		stop() {
			if (timer) {
				clearInterval(timer);
				timer = null;
			}
		},
		wasKilled() {
			return killed;
		},
	};
}
