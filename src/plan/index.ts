import type { LisaConfig } from "../types/index.js";

export interface RunPlanOptions {
	config: LisaConfig;
	goal?: string;
	issueId?: string;
	continueLatest?: boolean;
	jsonOutput?: boolean;
}

export async function runPlan(_opts: RunPlanOptions): Promise<void> {
	// Orchestrator — wired up in phases 3-5
	throw new Error("Not yet implemented");
}
