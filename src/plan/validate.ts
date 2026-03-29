import type { PlannedIssue } from "../types/index.js";

/**
 * Detect dependency cycles using Kahn's algorithm (BFS topological sort).
 * Returns `null` if the dependency graph is a valid DAG, or an array of
 * human-readable cycle descriptions if cycles exist.
 */
export function detectDependencyCycles(issues: PlannedIssue[]): string[] | null {
	const issueByOrder = new Map<number, PlannedIssue>();
	for (const issue of issues) {
		issueByOrder.set(issue.order, issue);
	}

	// Build adjacency list and in-degree map
	const adjacency = new Map<number, number[]>();
	const inDegree = new Map<number, number>();

	for (const issue of issues) {
		adjacency.set(issue.order, []);
		inDegree.set(issue.order, 0);
	}

	for (const issue of issues) {
		for (const dep of issue.dependsOn) {
			if (!adjacency.has(dep)) continue; // skip unknown dependencies
			adjacency.get(dep)!.push(issue.order);
			inDegree.set(issue.order, (inDegree.get(issue.order) ?? 0) + 1);
		}
	}

	// BFS: start with nodes that have no incoming edges
	const queue: number[] = [];
	for (const [order, degree] of inDegree) {
		if (degree === 0) queue.push(order);
	}

	const sorted: number[] = [];
	while (queue.length > 0) {
		const node = queue.shift()!;
		sorted.push(node);
		for (const neighbor of adjacency.get(node) ?? []) {
			const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
			inDegree.set(neighbor, newDegree);
			if (newDegree === 0) queue.push(neighbor);
		}
	}

	// If not all nodes were sorted, cycles exist
	if (sorted.length === issues.length) return null;

	// Identify nodes involved in cycles
	const sortedSet = new Set(sorted);
	const cycleNodes = issues
		.filter((i) => !sortedSet.has(i.order))
		.map((i) => `#${i.order} "${i.title}"`);

	return [`Circular dependency involving: ${cycleNodes.join(" -> ")}`];
}

/**
 * Detect files that appear in the `relevantFiles` of 2+ issues.
 * Returns entries where a file is touched by multiple issues (merge conflict risk).
 */
export function detectFileOverlaps(
	issues: PlannedIssue[],
): Array<{ file: string; issues: number[] }> {
	const fileMap = new Map<string, number[]>();

	for (const issue of issues) {
		for (const file of issue.relevantFiles) {
			const existing = fileMap.get(file);
			if (existing) {
				existing.push(issue.order);
			} else {
				fileMap.set(file, [issue.order]);
			}
		}
	}

	const overlaps: Array<{ file: string; issues: number[] }> = [];
	for (const [file, issueOrders] of fileMap) {
		if (issueOrders.length >= 2) {
			overlaps.push({ file, issues: issueOrders });
		}
	}

	return overlaps;
}
