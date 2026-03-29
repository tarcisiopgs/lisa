import { describe, expect, it } from "vitest";
import type { PlannedIssue } from "../types/index.js";
import { buildExecutionWaves } from "./waves.js";

function makeIssue(order: number, dependsOn: number[] = []): PlannedIssue {
	return {
		title: `Issue ${order}`,
		description: `Description for issue ${order}`,
		acceptanceCriteria: [],
		relevantFiles: [],
		order,
		dependsOn,
	};
}

describe("buildExecutionWaves", () => {
	it("returns empty array for empty input", () => {
		expect(buildExecutionWaves([])).toEqual([]);
	});

	it("returns single wave for a single issue", () => {
		const issues = [makeIssue(1)];
		expect(buildExecutionWaves(issues)).toEqual([[1]]);
	});

	it("puts all independent issues in a single wave", () => {
		const issues = [makeIssue(1), makeIssue(2), makeIssue(3)];
		expect(buildExecutionWaves(issues)).toEqual([[1, 2, 3]]);
	});

	it("creates separate waves for a linear chain (1->2->3)", () => {
		const issues = [makeIssue(1), makeIssue(2, [1]), makeIssue(3, [2])];
		expect(buildExecutionWaves(issues)).toEqual([[1], [2], [3]]);
	});

	it("handles diamond dependency (1,2 independent; 3 depends on 1,2; 4 depends on 3)", () => {
		const issues = [makeIssue(1), makeIssue(2), makeIssue(3, [1, 2]), makeIssue(4, [3])];
		expect(buildExecutionWaves(issues)).toEqual([[1, 2], [3], [4]]);
	});

	it("handles mixed independent and dependent issues", () => {
		const issues = [
			makeIssue(1),
			makeIssue(2),
			makeIssue(3, [1]),
			makeIssue(4),
			makeIssue(5, [3, 4]),
		];
		const waves = buildExecutionWaves(issues);
		expect(waves).toEqual([[1, 2, 4], [3], [5]]);
	});

	it("puts cyclic issues in a final wave (defensive)", () => {
		const issues = [makeIssue(1, [2]), makeIssue(2, [1])];
		const waves = buildExecutionWaves(issues);
		// Both are stuck in a cycle, flushed into a single wave
		expect(waves).toEqual([[1, 2]]);
	});
});
