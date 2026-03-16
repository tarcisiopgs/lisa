import type { Source, SourceConfig } from "../types/index.js";
import { kanbanEmitter } from "../ui/state.js";

// === Per-issue state maps for concurrent execution ===
export const activeCleanups = new Map<
	string,
	{ previousStatus: string; source: Source; sourceConfig: SourceConfig }
>();
export const activeProviderPids = new Map<string, number>();
export const providerPausedSet = new Set<string>();
export const userKilledSet = new Set<string>();
export const userSkippedSet = new Set<string>();
export const reconciliationSet = new Set<string>();

let _shuttingDown = false;
let _loopPaused = false;
let _userQuitFromWatchPrompt = false;

export function isShuttingDown(): boolean {
	return _shuttingDown;
}

export function setShuttingDown(value: boolean): void {
	_shuttingDown = value;
}

export function isLoopPaused(): boolean {
	return _loopPaused;
}

export function hasUserQuitFromWatchPrompt(): boolean {
	return _userQuitFromWatchPrompt;
}

export function setUserQuitFromWatchPrompt(value: boolean): void {
	_userQuitFromWatchPrompt = value;
}

export function killProviderForIssue(issueId: string): void {
	const pid = activeProviderPids.get(issueId);
	if (!pid) return;
	if (providerPausedSet.has(issueId)) {
		try {
			process.kill(pid, "SIGCONT");
		} catch {}
		providerPausedSet.delete(issueId);
	}
	try {
		process.kill(pid, "SIGTERM");
	} catch {}
	setTimeout(() => {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}, 5000);
}

export function setupEventListeners(): void {
	kanbanEmitter.on("loop:pause", () => {
		_loopPaused = true;
	});
	kanbanEmitter.on("loop:resume", () => {
		_loopPaused = false;
	});

	kanbanEmitter.on("loop:pause-provider", (issueId?: string) => {
		if (issueId) {
			// Pause a specific issue's provider
			const pid = activeProviderPids.get(issueId);
			if (pid) {
				try {
					process.kill(pid, "SIGSTOP");
				} catch {}
				providerPausedSet.add(issueId);
			}
		} else {
			// Pause ALL active providers
			for (const [id, pid] of activeProviderPids) {
				try {
					process.kill(pid, "SIGSTOP");
				} catch {}
				providerPausedSet.add(id);
			}
		}
		kanbanEmitter.emit("provider:paused", issueId);
	});

	kanbanEmitter.on("loop:resume-provider", (issueId?: string) => {
		if (issueId) {
			const pid = activeProviderPids.get(issueId);
			if (pid && providerPausedSet.has(issueId)) {
				try {
					process.kill(pid, "SIGCONT");
				} catch {}
				providerPausedSet.delete(issueId);
			}
		} else {
			// Resume ALL paused providers
			for (const id of providerPausedSet) {
				const pid = activeProviderPids.get(id);
				if (pid) {
					try {
						process.kill(pid, "SIGCONT");
					} catch {}
				}
			}
			providerPausedSet.clear();
		}
		kanbanEmitter.emit("provider:resumed", issueId);
	});

	kanbanEmitter.on("loop:kill", (issueId?: string) => {
		if (issueId) {
			userKilledSet.add(issueId);
			killProviderForIssue(issueId);
		} else {
			// Kill first active provider (backward compat for single concurrency)
			const firstId = activeProviderPids.keys().next().value;
			if (firstId) {
				userKilledSet.add(firstId);
				killProviderForIssue(firstId);
			}
		}
	});

	kanbanEmitter.on("loop:skip", (issueId?: string) => {
		if (issueId) {
			userSkippedSet.add(issueId);
			killProviderForIssue(issueId);
		} else {
			const firstId = activeProviderPids.keys().next().value;
			if (firstId) {
				userSkippedSet.add(firstId);
				killProviderForIssue(firstId);
			}
		}
	});

	kanbanEmitter.on("loop:quit", () => {
		_userQuitFromWatchPrompt = true;
		setShuttingDown(true);
	});
}
