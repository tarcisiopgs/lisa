import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PlanResult } from "../types/index.js";
import { deletePlan, loadLatestPlan, loadPlan, savePlan } from "./persistence.js";

function makePlan(overrides?: Partial<PlanResult>): PlanResult {
	return {
		goal: "Add rate limiting",
		issues: [
			{
				title: "Add middleware",
				description: "desc",
				acceptanceCriteria: ["works"],
				relevantFiles: ["src/a.ts"],
				order: 1,
				dependsOn: [],
			},
		],
		createdAt: "2026-03-19T12:00:00.000Z",
		status: "draft",
		...overrides,
	};
}

describe("persistence", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "lisa-plan-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("saves and loads a plan", () => {
		const plan = makePlan();
		const path = savePlan(tmpDir, plan);
		expect(path).toContain(".json");

		const loaded = loadPlan(path);
		expect(loaded).not.toBeNull();
		expect(loaded!.goal).toBe("Add rate limiting");
		expect(loaded!.issues).toHaveLength(1);
	});

	it("returns null for non-existent file", () => {
		expect(loadPlan("/nonexistent/path.json")).toBeNull();
	});

	it("loadLatestPlan returns most recent draft/approved plan", () => {
		savePlan(tmpDir, makePlan({ createdAt: "2026-03-19T10:00:00.000Z", status: "created" }));
		savePlan(tmpDir, makePlan({ createdAt: "2026-03-19T11:00:00.000Z", status: "draft" }));

		const result = loadLatestPlan(tmpDir);
		expect(result).not.toBeNull();
		expect(result![0].createdAt).toBe("2026-03-19T11:00:00.000Z");
	});

	it("loadLatestPlan returns null when all plans are created", () => {
		savePlan(tmpDir, makePlan({ status: "created" }));
		expect(loadLatestPlan(tmpDir)).toBeNull();
	});

	it("loadLatestPlan returns null for empty directory", () => {
		expect(loadLatestPlan(tmpDir)).toBeNull();
	});

	it("deletePlan removes the file", () => {
		const path = savePlan(tmpDir, makePlan());
		expect(loadPlan(path)).not.toBeNull();
		deletePlan(path);
		expect(loadPlan(path)).toBeNull();
	});

	it("deletePlan does not throw for non-existent file", () => {
		expect(() => deletePlan("/nonexistent/file.json")).not.toThrow();
	});
});
