import { describe, expect, it } from "vitest";
import type { PlannedIssue } from "../types/index.js";
import { detectDependencyCycles, detectFileOverlaps } from "./validate.js";

function makeIssue(
	order: number,
	dependsOn: number[] = [],
	relevantFiles: string[] = [],
): PlannedIssue {
	return {
		title: `Issue ${order}`,
		description: `Description for issue ${order}`,
		acceptanceCriteria: [],
		relevantFiles,
		order,
		dependsOn,
	};
}

describe("detectDependencyCycles", () => {
	it("returns null for a valid DAG", () => {
		const issues = [makeIssue(1), makeIssue(2, [1]), makeIssue(3, [2])];
		expect(detectDependencyCycles(issues)).toBeNull();
	});

	it("detects a simple cycle (A -> B -> A)", () => {
		const issues = [makeIssue(1, [2]), makeIssue(2, [1])];
		const result = detectDependencyCycles(issues);
		expect(result).not.toBeNull();
		expect(result!.length).toBeGreaterThan(0);
		expect(result![0]).toContain("#1");
		expect(result![0]).toContain("#2");
	});

	it("detects a self-reference (A -> A)", () => {
		const issues = [makeIssue(1, [1]), makeIssue(2)];
		const result = detectDependencyCycles(issues);
		expect(result).not.toBeNull();
		expect(result!.length).toBeGreaterThan(0);
		expect(result![0]).toContain("#1");
	});

	it("returns null for diamond dependencies (no cycle)", () => {
		// 1 -> 2, 1 -> 3, 2 -> 4, 3 -> 4
		const issues = [makeIssue(1), makeIssue(2, [1]), makeIssue(3, [1]), makeIssue(4, [2, 3])];
		expect(detectDependencyCycles(issues)).toBeNull();
	});

	it("detects a complex cycle in a larger graph", () => {
		// 1 -> 2 -> 3 -> 4 -> 2 (cycle), 5 depends on 1 (no cycle)
		const issues = [
			makeIssue(1),
			makeIssue(2, [1, 4]),
			makeIssue(3, [2]),
			makeIssue(4, [3]),
			makeIssue(5, [1]),
		];
		const result = detectDependencyCycles(issues);
		expect(result).not.toBeNull();
		expect(result!.length).toBeGreaterThan(0);
		expect(result![0]).toContain("#2");
		expect(result![0]).toContain("#3");
		expect(result![0]).toContain("#4");
	});

	it("returns null for issues with no dependencies", () => {
		const issues = [makeIssue(1), makeIssue(2), makeIssue(3)];
		expect(detectDependencyCycles(issues)).toBeNull();
	});
});

describe("detectFileOverlaps", () => {
	it("returns empty array when no overlaps exist", () => {
		const issues = [makeIssue(1, [], ["src/a.ts"]), makeIssue(2, [], ["src/b.ts"])];
		expect(detectFileOverlaps(issues)).toEqual([]);
	});

	it("detects a single file in multiple issues", () => {
		const issues = [
			makeIssue(1, [], ["src/shared.ts", "src/a.ts"]),
			makeIssue(2, [], ["src/shared.ts", "src/b.ts"]),
		];
		const result = detectFileOverlaps(issues);
		expect(result).toEqual([{ file: "src/shared.ts", issues: [1, 2] }]);
	});

	it("detects multiple overlapping files", () => {
		const issues = [
			makeIssue(1, [], ["src/a.ts", "src/b.ts", "src/c.ts"]),
			makeIssue(2, [], ["src/b.ts", "src/c.ts"]),
			makeIssue(3, [], ["src/c.ts"]),
		];
		const result = detectFileOverlaps(issues);
		expect(result).toHaveLength(2);
		expect(result).toContainEqual({ file: "src/b.ts", issues: [1, 2] });
		expect(result).toContainEqual({ file: "src/c.ts", issues: [1, 2, 3] });
	});

	it("returns empty array when no issues have relevantFiles", () => {
		const issues = [makeIssue(1), makeIssue(2)];
		expect(detectFileOverlaps(issues)).toEqual([]);
	});
});
