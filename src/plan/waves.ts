import type { PlannedIssue } from "../types/index.js";

/**
 * Build execution waves from the dependency DAG.
 * Wave 1 = issues with no dependencies.
 * Wave N = issues whose dependencies are all in waves 1..N-1.
 * Returns array of arrays of issue order numbers.
 */
export function buildExecutionWaves(issues: PlannedIssue[]): number[][] {
	if (issues.length === 0) return [];

	// Build dependency map: order -> set of dependsOn orders
	const remaining = new Map<number, Set<number>>();
	for (const issue of issues) {
		remaining.set(issue.order, new Set(issue.dependsOn));
	}

	const waves: number[][] = [];

	while (remaining.size > 0) {
		// Find all issues with no remaining dependencies
		const wave: number[] = [];
		for (const [order, deps] of remaining) {
			if (deps.size === 0) {
				wave.push(order);
			}
		}

		// Defensive: if no issues have empty deps, we have a cycle — flush remaining
		if (wave.length === 0) {
			waves.push([...remaining.keys()].sort((a, b) => a - b));
			break;
		}

		wave.sort((a, b) => a - b);
		waves.push(wave);

		// Remove assigned issues from the map and from all dependency sets
		const assigned = new Set(wave);
		for (const order of wave) {
			remaining.delete(order);
		}
		for (const deps of remaining.values()) {
			for (const a of assigned) {
				deps.delete(a);
			}
		}
	}

	return waves;
}
