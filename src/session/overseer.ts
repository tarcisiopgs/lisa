import type { ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { killWithEscalation } from "../providers/timeout.js";
import type { OverseerConfig } from "../types/index.js";
import { kanbanEmitter } from "../ui/state.js";
import { detectClaudeActivity } from "./activity.js";

const execFileAsync = promisify(execFile);

export const STUCK_MESSAGE =
	"\n[lisa-overseer] Provider killed: no git changes detected within the stuck threshold. Eligible for fallback.\n";

export const STALL_MESSAGE =
	"\n[lisa-stall] Provider killed: no output received within the stall timeout. Eligible for fallback.\n";

export interface OutputStallHandle {
	reset(): void;
	wasKilled(): boolean;
	stop(): void;
}

const DEFAULT_OUTPUT_STALL_TIMEOUT = 300;

/**
 * Monitors provider stdout for prolonged silence. Kills the process if no
 * output is received within `timeoutSeconds`. Each call to `reset()` restarts
 * the countdown — call it from the stdout data handler.
 *
 * Returns a no-op handle when timeoutSeconds is 0 or undefined (disabled).
 */
export function createOutputStallDetector(
	proc: ChildProcess,
	timeoutSeconds?: number,
): OutputStallHandle {
	const timeout = timeoutSeconds ?? DEFAULT_OUTPUT_STALL_TIMEOUT;
	if (timeout <= 0) {
		return { reset() {}, wasKilled: () => false, stop() {} };
	}

	let killed = false;
	let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
		killed = true;
		killWithEscalation(proc);
	}, timeout * 1000);

	return {
		reset() {
			if (killed || !timer) return;
			clearTimeout(timer);
			timer = setTimeout(() => {
				killed = true;
				killWithEscalation(proc);
			}, timeout * 1000);
		},
		wasKilled() {
			return killed;
		},
		stop() {
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
		},
	};
}

export interface ErrorLoopDetectorHandle {
	check(text: string): void;
	wasKilled(): boolean;
}

/**
 * Monitors provider output for consecutive error lines. Kills the process and
 * marks it eligible for fallback if `threshold` consecutive lines matching
 * `pattern` appear without any productive output in between.
 *
 * Use a provider-specific pattern when known (e.g. Gemini's "Error executing tool"),
 * or the generic /^Error / as a conservative fallback for other providers.
 */
export function createErrorLoopDetector(
	proc: ChildProcess,
	pattern: RegExp,
	threshold = 25,
): ErrorLoopDetectorHandle {
	let consecutive = 0;
	let killed = false;

	return {
		check(text: string) {
			if (killed) return;
			for (const line of text.split("\n")) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				if (pattern.test(trimmed)) {
					if (++consecutive >= threshold) {
						killed = true;
						killWithEscalation(proc);
						return;
					}
				} else {
					consecutive = 0;
				}
			}
		},
		wasKilled() {
			return killed;
		},
	};
}

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
	let paused = false;
	let checkInProgress = false;
	let lastSnapshot: string | undefined;
	let lastChangeTime = Date.now();
	let timer: ReturnType<typeof setInterval> | null = null;

	const onPauseProvider = () => {
		paused = true;
	};
	const onResumeProvider = () => {
		paused = false;
		// Reset idle timer so paused time is not counted as stuck
		lastChangeTime = Date.now();
	};

	kanbanEmitter.on("loop:pause-provider", onPauseProvider);
	kanbanEmitter.on("loop:resume-provider", onResumeProvider);

	const check = async () => {
		if (killed || paused || checkInProgress) return;

		checkInProgress = true;
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
				killWithEscalation(proc);
			}
		} catch {
			// Ignore monitoring errors — do not interrupt the provider
		} finally {
			checkInProgress = false;
		}
	};

	timer = setInterval(check, config.check_interval * 1000);
	// Prevent the timer from keeping the process alive if stop() is never called
	if (timer && typeof timer === "object" && "unref" in timer) {
		timer.unref();
	}

	return {
		stop() {
			if (timer) {
				clearInterval(timer);
				timer = null;
			}
			kanbanEmitter.off("loop:pause-provider", onPauseProvider);
			kanbanEmitter.off("loop:resume-provider", onResumeProvider);
		},
		wasKilled() {
			return killed;
		},
	};
}

export function startEnhancedOverseer(
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
	let paused = false;
	let checkInProgress = false;
	let lastSnapshot: string | undefined;
	let lastChangeTime = Date.now();
	let timer: ReturnType<typeof setInterval> | null = null;

	const onPauseProvider = () => {
		paused = true;
	};
	const onResumeProvider = () => {
		paused = false;
		// Reset idle timer so paused time is not counted as stuck
		lastChangeTime = Date.now();
	};

	kanbanEmitter.on("loop:pause-provider", onPauseProvider);
	kanbanEmitter.on("loop:resume-provider", onResumeProvider);

	const check = async () => {
		if (killed || paused || checkInProgress) return;

		checkInProgress = true;
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

			// Git status unchanged — check JSONL activity as secondary signal
			const activity = detectClaudeActivity(cwd);
			if (activity === "active") {
				// Agent is actively working (reading files, running tools)
				// Reset timer — it hasn't produced git changes yet but is not stuck
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
				killWithEscalation(proc);
			}
		} catch {
			// Ignore monitoring errors — do not interrupt the provider
		} finally {
			checkInProgress = false;
		}
	};

	timer = setInterval(check, config.check_interval * 1000);
	// Prevent the timer from keeping the process alive if stop() is never called
	if (timer && typeof timer === "object" && "unref" in timer) {
		timer.unref();
	}

	return {
		stop() {
			if (timer) {
				clearInterval(timer);
				timer = null;
			}
			kanbanEmitter.off("loop:pause-provider", onPauseProvider);
			kanbanEmitter.off("loop:resume-provider", onResumeProvider);
		},
		wasKilled() {
			return killed;
		},
	};
}
