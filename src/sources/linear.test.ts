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

describe("LinearSource.fetchNextIssue multi-label", () => {
	beforeEach(() => {
		process.env.LINEAR_API_KEY = "test-key";
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("filters issues by all labels with AND logic", async () => {
		const response = {
			data: {
				issues: {
					nodes: [
						{
							id: "1",
							identifier: "ENG-1",
							title: "Has both labels",
							description: "desc1",
							url: "https://linear.app/issue/ENG-1",
							priority: 1,
							labels: { nodes: [{ name: "ready" }, { name: "api" }] },
							inverseRelations: { nodes: [] },
						},
						{
							id: "2",
							identifier: "ENG-2",
							title: "Only has first label",
							description: "desc2",
							url: "https://linear.app/issue/ENG-2",
							priority: 2,
							labels: { nodes: [{ name: "ready" }] },
							inverseRelations: { nodes: [] },
						},
					],
				},
			},
		};

		vi.stubGlobal("fetch", mockFetch(response));

		const source = new LinearSource();
		const result = await source.fetchNextIssue({
			team: "Engineering",
			project: "Backend",
			label: ["ready", "api"],
			pick_from: "Backlog",
			in_progress: "In Progress",
			done: "Done",
		});

		expect(result).not.toBeNull();
		expect(result?.id).toBe("ENG-1");
		expect(result?.title).toBe("Has both labels");
	});

	it("returns null when no issues match all labels", async () => {
		const response = {
			data: {
				issues: {
					nodes: [
						{
							id: "1",
							identifier: "ENG-1",
							title: "Only one label",
							description: "",
							url: "https://linear.app/issue/ENG-1",
							priority: 1,
							labels: { nodes: [{ name: "ready" }] },
							inverseRelations: { nodes: [] },
						},
					],
				},
			},
		};

		vi.stubGlobal("fetch", mockFetch(response));

		const source = new LinearSource();
		const result = await source.fetchNextIssue({
			team: "Engineering",
			project: "Backend",
			label: ["ready", "api"],
			pick_from: "Backlog",
			in_progress: "In Progress",
			done: "Done",
		});

		expect(result).toBeNull();
	});
});

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

	it("filters by all labels with AND logic for multi-label config", async () => {
		const response = {
			data: {
				issues: {
					nodes: [
						{
							identifier: "ENG-1",
							title: "Has both",
							description: "",
							url: "https://linear.app/issue/ENG-1",
							labels: { nodes: [{ name: "ready" }, { name: "api" }] },
						},
						{
							identifier: "ENG-2",
							title: "Has only one",
							description: "",
							url: "https://linear.app/issue/ENG-2",
							labels: { nodes: [{ name: "ready" }] },
						},
					],
				},
			},
		};

		vi.stubGlobal("fetch", mockFetch(response));

		const source = new LinearSource();
		const issues = await source.listIssues({
			...config,
			label: ["ready", "api"],
		});

		expect(issues).toHaveLength(1);
		expect(issues[0]).toMatchObject({ id: "ENG-1", title: "Has both" });
	});
});
