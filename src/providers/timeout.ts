import type { ChildProcess } from "node:child_process";

export const TIMEOUT_MESSAGE =
	"\n[lisa-timeout] Provider killed: exceeded session_timeout. Eligible for fallback.\n";

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
		proc.kill("SIGTERM");
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
