import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LinearSource } from "./linear.js";

function mockFetch(response: unknown, ok = true) {
	return vi.fn().mockResolvedValue({
		ok,
		status: ok ? 200 : 400,
		json: async () => response,
		text: async () => JSON.stringify(response),
	});
}

const config = {
	team: "Engineering",
	project: "Backend",
	label: "lisa",
	pick_from: "Backlog",
	in_progress: "In Progress",
	done: "Done",
};

describe("LinearSource.listIssues", () => {
	beforeEach(() => {
		process.env.LINEAR_API_KEY = "test-key";
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns all issues with the configured label and status", async () => {
		const response = {
			data: {
				issues: {
					nodes: [
						{
							identifier: "ENG-1",
							title: "First issue",
							description: "desc1",
							url: "https://linear.app/issue/ENG-1",
						},
						{
							identifier: "ENG-2",
							title: "Second issue",
							description: "desc2",
							url: "https://linear.app/issue/ENG-2",
						},
					],
				},
			},
		};

		vi.stubGlobal("fetch", mockFetch(response));

		const source = new LinearSource();
		const issues = await source.listIssues(config);

		expect(issues).toHaveLength(2);
		expect(issues[0]).toMatchObject({ id: "ENG-1", title: "First issue" });
		expect(issues[1]).toMatchObject({ id: "ENG-2", title: "Second issue" });
	});

	it("returns empty array when no matching issues", async () => {
		const response = { data: { issues: { nodes: [] } } };
		vi.stubGlobal("fetch", mockFetch(response));

		const source = new LinearSource();
		const issues = await source.listIssues(config);

		expect(issues).toEqual([]);
	});
});
