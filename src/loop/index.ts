import { join, resolve } from "node:path";
import { formatLabels } from "../config.js";
import * as logger from "../output/logger.js";
import { ensureCacheDir, rotateLogFiles } from "../paths.js";
import { migrateGuardrails } from "../session/guardrails.js";
import { createSource } from "../sources/index.js";
import type { LisaConfig } from "../types/index.js";
import { kanbanEmitter } from "../ui/state.js";
import { runConcurrentLoop } from "./concurrent.js";
import { ensureWorkspaceContext } from "./context-generation.js";
import type { LoopOptions } from "./models.js";
import { resolveModels } from "./models.js";
import { recoverOrphanIssues } from "./recovery.js";
import { runSequentialLoop } from "./sequential.js";
import { installSignalHandlers } from "./signals.js";
import { setupEventListeners } from "./state.js";

// Register kanban event listeners at module load time
setupEventListeners();

export async function runLoop(config: LisaConfig, opts: LoopOptions): Promise<void> {
	const source = createSource(config.source);
	const models = resolveModels(config);
	const workspace = resolve(config.workspace);
	const concurrency = opts.concurrency;

	installSignalHandlers(opts.onBeforeExit);

	// Prepare system cache directory and migrate legacy artifacts
	ensureCacheDir(workspace);
	migrateGuardrails(workspace);
	rotateLogFiles(workspace);

	if (!opts.dryRun) {
		const contextLogFile = join(workspace, ".lisa", "context-generation.log");
		await ensureWorkspaceContext(config, models, workspace, contextLogFile);
	}

	logger.log(
		`Starting loop (models: ${models.map((m) => (m.model ? `${m.provider}/${m.model}` : m.provider)).join(" → ")}, source: ${config.source}, label: ${formatLabels(config.source_config)}, workflow: ${config.workflow}${concurrency > 1 ? `, concurrency: ${concurrency}` : ""})`,
	);

	// Recover orphan issues stuck in in_progress from previous interrupted runs
	if (!opts.dryRun) {
		await recoverOrphanIssues(source, config);
	}

	// Pre-populate kanban backlog when TUI is active
	if (kanbanEmitter.listenerCount("issue:queued") > 0) {
		try {
			const allIssues = await source.listIssues(config.source_config);
			for (const issue of allIssues) {
				kanbanEmitter.emit("issue:queued", issue);
			}
		} catch {
			// Non-fatal — kanban backlog starts empty
		}
	}

	if (concurrency <= 1) {
		// Sequential mode — original behavior
		await runSequentialLoop(config, source, models, workspace, opts);
	} else {
		// Concurrent pool mode
		await runConcurrentLoop(config, source, models, workspace, opts);
	}
}

export { runDemoLoop } from "./demo.js";
export { checkoutBaseBranches } from "./helpers.js";
export type { LoopOptions } from "./models.js";
export { WATCH_POLL_INTERVAL_MS } from "./models.js";
