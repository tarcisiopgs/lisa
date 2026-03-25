import { describe, expect, it, vi } from "vitest";
import type { PlanResult, Source, SourceConfig } from "../types/index.js";
import { createPlanIssues } from "./create.js";

function makeSource(overrides: Partial<Source> = {}): Source {
	return {
		name: "linear",
		fetchNextIssue: vi.fn(),
		fetchIssueById: vi.fn(),
		updateStatus: vi.fn(),
		removeLabel: vi.fn(),
		attachPullRequest: vi.fn(),
		completeIssue: vi.fn(),
		listIssues: vi.fn(),
		createIssue: vi.fn().mockResolvedValue("ISSUE-1"),
		...overrides,
	};
}

const config: SourceConfig = {
	scope: "team",
	project: "proj",
	label: "ready",
	pick_from: "Todo",
	in_progress: "In Progress",
	done: "Done",
};

describe("createPlanIssues", () => {
	it("continues creating issues when one fails", async () => {
		const createIssue = vi
			.fn()
			.mockResolvedValueOnce("ISSUE-1")
			.mockRejectedValueOnce(new Error("API error"))
			.mockResolvedValueOnce("ISSUE-3");

		const source = makeSource({ createIssue });
		const plan: PlanResult = {
			goal: "test",
			issues: [
				{
					title: "Issue 1",
					description: "desc 1",
					acceptanceCriteria: ["should work"],
					relevantFiles: [],
					order: 1,
					dependsOn: [],
				},
				{
					title: "Issue 2",
					description: "desc 2",
					acceptanceCriteria: ["should work"],
					relevantFiles: [],
					order: 2,
					dependsOn: [],
				},
				{
					title: "Issue 3",
					description: "desc 3",
					acceptanceCriteria: ["should work"],
					relevantFiles: [],
					order: 3,
					dependsOn: [],
				},
			],
			createdAt: new Date().toISOString(),
			status: "approved",
		};

		const ids = await createPlanIssues(source, config, plan);

		expect(ids).toEqual(["ISSUE-1", "ISSUE-3"]);
		expect(createIssue).toHaveBeenCalledTimes(3);
	});

	it("appends acceptance criteria checklist when missing from description", async () => {
		const createIssue = vi.fn().mockResolvedValue("ISSUE-1");
		const source = makeSource({ createIssue });
		const plan: PlanResult = {
			goal: "test",
			issues: [
				{
					title: "Issue 1",
					description: "Plain description without checklist",
					acceptanceCriteria: ["tests pass", "lint clean"],
					relevantFiles: [],
					order: 1,
					dependsOn: [],
				},
			],
			createdAt: new Date().toISOString(),
			status: "approved",
		};

		await createPlanIssues(source, config, plan);

		const call = createIssue.mock.calls[0]![0];
		expect(call.description).toContain("## Acceptance Criteria");
		expect(call.description).toContain("- [ ] tests pass");
		expect(call.description).toContain("- [ ] lint clean");
	});

	it("does not duplicate checklist when description already has one", async () => {
		const createIssue = vi.fn().mockResolvedValue("ISSUE-1");
		const source = makeSource({ createIssue });
		const plan: PlanResult = {
			goal: "test",
			issues: [
				{
					title: "Issue 1",
					description: "Description\n\n- [ ] existing checklist item",
					acceptanceCriteria: ["existing checklist item"],
					relevantFiles: [],
					order: 1,
					dependsOn: [],
				},
			],
			createdAt: new Date().toISOString(),
			status: "approved",
		};

		await createPlanIssues(source, config, plan);

		const call = createIssue.mock.calls[0]![0];
		expect(call.description).not.toContain("## Acceptance Criteria");
		expect(call.description).toBe("Description\n\n- [ ] existing checklist item");
	});
});
