import type { ChildProcess } from "node:child_process";

export const TIMEOUT_MESSAGE =
	"\n[lisa-timeout] Provider killed: exceeded session_timeout. Eligible for fallback.\n";

/** Grace period (ms) between SIGTERM and SIGKILL escalation. */
const SIGKILL_GRACE_MS = 10_000;

/**
 * Sends SIGTERM to a process and escalates to SIGKILL if it doesn't exit
 * within the grace period.
 */
export function killWithEscalation(proc: ChildProcess): void {
	proc.kill("SIGTERM");
	const escalation = setTimeout(() => {
		try {
			proc.kill("SIGKILL");
		} catch {
			// Process may already be dead
		}
	}, SIGKILL_GRACE_MS);
	// Don't keep the process alive just for the escalation timer
	if (escalation && typeof escalation === "object" && "unref" in escalation) {
		escalation.unref();
	}
}

export interface SessionTimeoutHandle {
	stop(): void;
	wasTimedOut(): boolean;
}

/**
 * Creates a session-level timeout that kills the provider process after the
 * configured number of seconds. Returns a no-op handle when timeoutSeconds
 * is 0 or undefined (disabled by default — the user must opt in).
 */
export function createSessionTimeout(
	proc: ChildProcess,
	timeoutSeconds?: number,
): SessionTimeoutHandle {
	if (!timeoutSeconds || timeoutSeconds <= 0) {
		return { stop() {}, wasTimedOut: () => false };
	}

	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		killWithEscalation(proc);
	}, timeoutSeconds * 1000);

	return {
		stop() {
			clearTimeout(timer);
		},
		wasTimedOut() {
			return timedOut;
		},
	};
}
