import { formatError } from "../errors.js";
import * as logger from "../output/logger.js";
import { resetTitle, stopSpinner } from "../output/terminal.js";
import { kanbanEmitter } from "../ui/state.js";
import { activeCleanups, activeProviderPids, isShuttingDown, setShuttingDown } from "./state.js";

export function installSignalHandlers(onBeforeExit?: () => void): void {
	const cleanup = async (signal: string): Promise<void> => {
		if (isShuttingDown()) {
			logger.warn("Force exiting...");
			process.exit(1);
		}
		setShuttingDown(true);
		stopSpinner();
		resetTitle();
		logger.warn(`Received ${signal}. Reverting active issues...`);

		// Kill all active provider processes
		for (const [, pid] of activeProviderPids) {
			try {
				process.kill(pid, "SIGTERM");
			} catch {
				/* process already exited */
			}
		}

		// Revert all active issues
		const revertPromises = [...activeCleanups.entries()].map(
			async ([issueId, { previousStatus, source, sourceConfig }]) => {
				try {
					await Promise.race([
						source.updateStatus(issueId, previousStatus, sourceConfig),
						new Promise<never>((_, reject) =>
							setTimeout(() => reject(new Error("Revert timed out")), 5000),
						),
					]);
					logger.ok(`Reverted ${issueId} to "${previousStatus}"`);
				} catch (err) {
					logger.error(`Failed to revert ${issueId}: ${formatError(err)}`);
				}
				kanbanEmitter.emit("issue:reverted", issueId);
			},
		);

		await Promise.allSettled(revertPromises);

		// Signal the TUI to exit cleanly (if running)
		const hasTUI = kanbanEmitter.listenerCount("tui:exit") > 0;
		kanbanEmitter.emit("tui:exit");
		if (hasTUI) {
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		onBeforeExit?.();
		process.exit(0);
	};

	process.on("SIGINT", () => {
		cleanup("SIGINT");
	});
	process.on("SIGTERM", () => {
		cleanup("SIGTERM");
	});
}
