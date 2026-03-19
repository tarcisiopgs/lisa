import type { PlanResult } from "../types/index.js";
import type { RunPlanOptions } from "./index.js";

/**
 * Interactive wizard for reviewing and editing a plan.
 * Returns true if the user approved the plan, false if cancelled.
 */
export async function runPlanWizard(
	_plan: PlanResult,
	_planPath: string,
	_opts: RunPlanOptions,
): Promise<boolean> {
	// Implemented in Phase 4
	return true;
}
