import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LineageContext } from "../types/index.js";
import {
	buildLineagePromptBlock,
	loadLineage,
	loadLineageForIssue,
	saveLineage,
} from "./lineage.js";

const TMP_DIR = join(import.meta.dirname ?? __dirname, "__lineage_test_tmp__");

beforeEach(() => {
	mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
	rmSync(TMP_DIR, { recursive: true, force: true });
});

const sampleLineage: LineageContext = {
	planId: "2024-01-01T00:00:00.000Z",
	goal: "Build authentication system",
	issues: [
		{ id: "AUTH-1", title: "Set up user model", order: 1 },
		{ id: "AUTH-2", title: "Implement login endpoint", order: 2 },
		{ id: "AUTH-3", title: "Add JWT support", order: 3 },
	],
};

describe("saveLineage + loadLineage", () => {
	it("saves and loads a round-trip correctly", () => {
		saveLineage(TMP_DIR, sampleLineage);
		const loaded = loadLineage(TMP_DIR, sampleLineage.planId);
		expect(loaded).toEqual(sampleLineage);
	});

	it("returns null for a non-existent planId", () => {
		const result = loadLineage(TMP_DIR, "non-existent-plan");
		expect(result).toBeNull();
	});

	it("creates the lineage directory if it does not exist", () => {
		const workspace = join(TMP_DIR, "nested", "workspace");
		saveLineage(workspace, sampleLineage);
		const loaded = loadLineage(workspace, sampleLineage.planId);
		expect(loaded).toEqual(sampleLineage);
	});

	it("sanitizes planId with special characters for the filesystem", () => {
		const lineage: LineageContext = {
			...sampleLineage,
			planId: "2024-01-01T00:00:00.000Z",
		};
		saveLineage(TMP_DIR, lineage);
		const loaded = loadLineage(TMP_DIR, lineage.planId);
		expect(loaded).toEqual(lineage);
	});
});

describe("loadLineageForIssue", () => {
	it("finds the correct lineage for a known issueId", () => {
		saveLineage(TMP_DIR, sampleLineage);
		const result = loadLineageForIssue(TMP_DIR, "AUTH-2");
		expect(result).toEqual(sampleLineage);
	});

	it("returns null for an unknown issueId", () => {
		saveLineage(TMP_DIR, sampleLineage);
		const result = loadLineageForIssue(TMP_DIR, "UNKNOWN-99");
		expect(result).toBeNull();
	});

	it("returns null when the lineage directory does not exist", () => {
		const result = loadLineageForIssue(join(TMP_DIR, "no-such-dir"), "AUTH-1");
		expect(result).toBeNull();
	});

	it("scans multiple files and finds the correct one", () => {
		const otherLineage: LineageContext = {
			planId: "other-plan",
			goal: "Other goal",
			issues: [{ id: "OTHER-1", title: "Other task", order: 1 }],
		};
		saveLineage(TMP_DIR, sampleLineage);
		saveLineage(TMP_DIR, otherLineage);

		expect(loadLineageForIssue(TMP_DIR, "AUTH-3")).toEqual(sampleLineage);
		expect(loadLineageForIssue(TMP_DIR, "OTHER-1")).toEqual(otherLineage);
	});
});

describe("buildLineagePromptBlock", () => {
	it("returns empty string for single-issue lineage", () => {
		const singleIssue: LineageContext = {
			planId: "plan-1",
			goal: "Single task goal",
			issues: [{ id: "TASK-1", title: "Only task", order: 1 }],
		};
		const result = buildLineagePromptBlock(singleIssue, "TASK-1");
		expect(result).toBe("");
	});

	it("builds a block with siblings and includes (this task) marker", () => {
		const result = buildLineagePromptBlock(sampleLineage, "AUTH-2");

		expect(result).toContain("## Task Hierarchy");
		expect(result).toContain("**Goal:** Build authentication system");
		expect(result).toContain("3 subtasks");
		expect(result).toContain("[AUTH-2] Implement login endpoint <-- (this task)");
		expect(result).toContain("## Parallel Work");
		expect(result).toContain("[AUTH-1] Set up user model");
		expect(result).toContain("[AUTH-3] Add JWT support");
	});

	it("does not include the current task in the parallel work section", () => {
		const result = buildLineagePromptBlock(sampleLineage, "AUTH-1");

		// AUTH-1 should appear in the task list but not in parallel work
		expect(result).toContain("[AUTH-1] Set up user model <-- (this task)");
		// The parallel work section should only have AUTH-2 and AUTH-3
		const parallelSection = result.split("## Parallel Work")[1];
		expect(parallelSection).not.toContain("[AUTH-1]");
		expect(parallelSection).toContain("[AUTH-2]");
		expect(parallelSection).toContain("[AUTH-3]");
	});

	it("returns empty string for lineage with zero issues", () => {
		const emptyLineage: LineageContext = {
			planId: "empty-plan",
			goal: "Empty",
			issues: [],
		};
		const result = buildLineagePromptBlock(emptyLineage, "NONEXISTENT");
		expect(result).toBe("");
	});
});
