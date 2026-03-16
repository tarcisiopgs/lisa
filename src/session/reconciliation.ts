import { killProviderForIssue, reconciliationSet } from "../loop/state.js";
import * as logger from "../output/logger.js";
import type { ReconciliationConfig, Source, SourceConfig } from "../types/index.js";
import { kanbanEmitter } from "../ui/state.js";

export const RECONCILED_MESSAGE =
	"\n[lisa-reconciliation] Provider killed: issue status changed externally. Skipping.\n";

const DEFAULT_CHECK_INTERVAL = 30;

export interface ReconciliationHandle {
	stop(): void;
	wasReconciled(): boolean;
}

/**
 * Starts a periodic monitor that checks if the issue's status changed
 * externally in the tracker. If the issue was moved to a terminal state,
 * deleted, or moved out of in_progress, the provider process is killed
 * and the issue is added to `reconciliationSet`.
 *
 * Returns a handle to stop the monitor and check if reconciliation occurred.
 */
export function startReconciliation(
	source: Source,
	issueId: string,
	config: ReconciliationConfig,
	sourceConfig: SourceConfig,
): ReconciliationHandle {
	if (!config.enabled) {
		return { stop() {}, wasReconciled: () => false };
	}

	let reconciled = false;
	let paused = false;
	const intervalMs = (config.check_interval ?? DEFAULT_CHECK_INTERVAL) * 1000;

	const onPause = () => {
		paused = true;
	};
	const onResume = () => {
		paused = false;
	};

	kanbanEmitter.on("loop:pause-provider", onPause);
	kanbanEmitter.on("loop:resume-provider", onResume);

	const check = async () => {
		if (reconciled || paused) return;

		try {
			const issue = await source.fetchIssueById(issueId);

			if (!issue) {
				// Issue was deleted or is no longer accessible
				reconciled = true;
				reconciliationSet.add(issueId);
				logger.warn(`Issue ${issueId} no longer found in tracker. Killing provider.`);
				killProviderForIssue(issueId);
				cleanup();
				return;
			}

			// Check if status moved away from in_progress
			if (issue.status) {
				const currentStatus = issue.status.toLowerCase();
				const inProgress = sourceConfig.in_progress.toLowerCase();
				const done = sourceConfig.done.toLowerCase();

				if (currentStatus === done || (inProgress && currentStatus !== inProgress)) {
					reconciled = true;
					reconciliationSet.add(issueId);
					logger.warn(
						`Issue ${issueId} status changed to "${issue.status}" externally. Killing provider.`,
					);
					killProviderForIssue(issueId);
					cleanup();
				}
			}
		} catch {
			// Ignore transient errors — do not interrupt the provider
		}
	};

	let timer: ReturnType<typeof setInterval> | null = setInterval(check, intervalMs);
	if (timer && typeof timer === "object" && "unref" in timer) {
		timer.unref();
	}

	function cleanup() {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		kanbanEmitter.off("loop:pause-provider", onPause);
		kanbanEmitter.off("loop:resume-provider", onResume);
	}

	return {
		stop() {
			cleanup();
		},
		wasReconciled() {
			return reconciled;
		},
	};
}
