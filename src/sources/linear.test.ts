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

describe("LinearSource.fetchNextIssue completedBlockerIds", () => {
	beforeEach(() => {
		process.env.LINEAR_API_KEY = "test-key";
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns completedBlockerIds for unblocked issue with completed blockers", async () => {
		const response = {
			data: {
				issues: {
					nodes: [
						{
							id: "1",
							identifier: "ENG-2",
							title: "Dependent issue",
							description: "",
							url: "https://linear.app/issue/ENG-2",
							priority: 1,
							labels: { nodes: [{ name: "lisa" }] },
							inverseRelations: {
								nodes: [
									{
										type: "blocks",
										issue: {
											identifier: "ENG-1",
											state: { type: "completed" },
										},
									},
								],
							},
						},
					],
				},
			},
		};

		vi.stubGlobal("fetch", mockFetch(response));

		const source = new LinearSource();
		const result = await source.fetchNextIssue(config);

		expect(result).not.toBeNull();
		expect(result?.id).toBe("ENG-2");
		expect(result?.completedBlockerIds).toEqual(["ENG-1"]);
	});

	it("does not include completedBlockerIds when no completed blockers", async () => {
		const response = {
			data: {
				issues: {
					nodes: [
						{
							id: "1",
							identifier: "ENG-1",
							title: "No blockers",
							description: "",
							url: "https://linear.app/issue/ENG-1",
							priority: 1,
							labels: { nodes: [{ name: "lisa" }] },
							inverseRelations: { nodes: [] },
						},
					],
				},
			},
		};

		vi.stubGlobal("fetch", mockFetch(response));

		const source = new LinearSource();
		const result = await source.fetchNextIssue(config);

		expect(result).not.toBeNull();
		expect(result?.completedBlockerIds).toBeUndefined();
	});

	it("returns null for issues where all blockers are still active", async () => {
		const response = {
			data: {
				issues: {
					nodes: [
						{
							id: "1",
							identifier: "ENG-2",
							title: "Blocked issue",
							description: "",
							url: "https://linear.app/issue/ENG-2",
							priority: 1,
							labels: { nodes: [{ name: "lisa" }] },
							inverseRelations: {
								nodes: [
									{
										type: "blocks",
										issue: {
											identifier: "ENG-1",
											state: { type: "started" },
										},
									},
								],
							},
						},
					],
				},
			},
		};

		vi.stubGlobal("fetch", mockFetch(response));

		const source = new LinearSource();
		const result = await source.fetchNextIssue(config);

		expect(result).toBeNull();
	});

	it("tracks multiple completed blockers", async () => {
		const response = {
			data: {
				issues: {
					nodes: [
						{
							id: "1",
							identifier: "ENG-3",
							title: "Has two completed blockers",
							description: "",
							url: "https://linear.app/issue/ENG-3",
							priority: 1,
							labels: { nodes: [{ name: "lisa" }] },
							inverseRelations: {
								nodes: [
									{
										type: "blocks",
										issue: {
											identifier: "ENG-1",
											state: { type: "completed" },
										},
									},
									{
										type: "blocks",
										issue: {
											identifier: "ENG-2",
											state: { type: "completed" },
										},
									},
								],
							},
						},
					],
				},
			},
		};

		vi.stubGlobal("fetch", mockFetch(response));

		const source = new LinearSource();
		const result = await source.fetchNextIssue(config);

		expect(result).not.toBeNull();
		expect(result?.completedBlockerIds).toEqual(["ENG-1", "ENG-2"]);
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

describe("LinearSource.addLabel", () => {
	beforeEach(() => {
		process.env.LINEAR_API_KEY = "test-key";
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("auto-creates the label when not found in team, then adds it to the issue", async () => {
		let callCount = 0;
		global.fetch = vi.fn().mockImplementation(async () => {
			callCount++;
			if (callCount === 1) {
				return {
					ok: true,
					json: async () => ({
						data: {
							issue: {
								id: "internal-id-1",
								team: { id: "team-1", labels: { nodes: [] } },
								labels: { nodes: [] },
							},
						},
					}),
				};
			}
			if (callCount === 2) {
				return {
					ok: true,
					json: async () => ({
						data: {
							labelCreate: {
								success: true,
								label: { id: "label-new-id", name: "needs-spec" },
							},
						},
					}),
				};
			}
			return {
				ok: true,
				json: async () => ({
					data: { issueUpdate: { success: true } },
				}),
			};
		});

		const source = new LinearSource();
		await expect(source.addLabel("ENG-1", "needs-spec")).resolves.not.toThrow();
		expect(callCount).toBe(3);
	});

	it("adds existing label without creating a new one", async () => {
		let callCount = 0;
		global.fetch = vi.fn().mockImplementation(async () => {
			callCount++;
			if (callCount === 1) {
				return {
					ok: true,
					json: async () => ({
						data: {
							issue: {
								id: "internal-id-1",
								team: {
									id: "team-1",
									labels: { nodes: [{ id: "label-existing", name: "needs-spec" }] },
								},
								labels: { nodes: [] },
							},
						},
					}),
				};
			}
			return {
				ok: true,
				json: async () => ({
					data: { issueUpdate: { success: true } },
				}),
			};
		});

		const source = new LinearSource();
		await expect(source.addLabel("ENG-1", "needs-spec")).resolves.not.toThrow();
		expect(callCount).toBe(2);
	});

	it("skips issueUpdate when issue already has the label", async () => {
		global.fetch = mockFetch({
			data: {
				issue: {
					id: "internal-id-1",
					team: {
						id: "team-1",
						labels: { nodes: [{ id: "label-id", name: "needs-spec" }] },
					},
					labels: { nodes: [{ id: "label-id", name: "needs-spec" }] },
				},
			},
		});

		const source = new LinearSource();
		await expect(source.addLabel("ENG-1", "needs-spec")).resolves.not.toThrow();
		expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(1);
	});

	it("handles race condition: labelCreate fails but label found on refetch", async () => {
		let callCount = 0;
		global.fetch = vi.fn().mockImplementation(async () => {
			callCount++;
			if (callCount === 1) {
				// Initial fetch: label not in team
				return {
					ok: true,
					json: async () => ({
						data: {
							issue: {
								id: "internal-id-1",
								team: { id: "team-1", labels: { nodes: [] } },
								labels: { nodes: [] },
							},
						},
					}),
				};
			}
			if (callCount === 2) {
				// labelCreate fails (race condition: another process created it)
				return {
					ok: true,
					json: async () => ({
						data: {
							labelCreate: { success: false, label: null },
						},
					}),
				};
			}
			if (callCount === 3) {
				// Refetch: label now exists in team
				return {
					ok: true,
					json: async () => ({
						data: {
							issue: {
								team: {
									labels: { nodes: [{ id: "label-race-id", name: "needs-spec" }] },
								},
							},
						},
					}),
				};
			}
			// callCount === 4: issueUpdate
			return {
				ok: true,
				json: async () => ({
					data: { issueUpdate: { success: true } },
				}),
			};
		});

		const source = new LinearSource();
		await expect(source.addLabel("ENG-1", "needs-spec")).resolves.not.toThrow();
		expect(callCount).toBe(4);
	});

	it("throws when labelCreate fails and label still not found after refetch", async () => {
		let callCount = 0;
		global.fetch = vi.fn().mockImplementation(async () => {
			callCount++;
			if (callCount === 1) {
				// Initial fetch: label not in team
				return {
					ok: true,
					json: async () => ({
						data: {
							issue: {
								id: "internal-id-1",
								team: { id: "team-1", labels: { nodes: [] } },
								labels: { nodes: [] },
							},
						},
					}),
				};
			}
			if (callCount === 2) {
				// labelCreate fails
				return {
					ok: true,
					json: async () => ({
						data: {
							labelCreate: { success: false, label: null },
						},
					}),
				};
			}
			// callCount === 3: Refetch also returns no matching label
			return {
				ok: true,
				json: async () => ({
					data: {
						issue: {
							team: { labels: { nodes: [] } }, // label not there either
						},
					},
				}),
			};
		});

		const source = new LinearSource();
		await expect(source.addLabel("ENG-1", "needs-spec")).rejects.toThrow(
			'Failed to create or find label "needs-spec" in team',
		);
		expect(callCount).toBe(3);
	});
});
