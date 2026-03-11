import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShortcutSource } from "./shortcut.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeWorkflow(
	overrides: Partial<{ id: number; name: string; states: ShortcutWorkflowState[] }> = {},
) {
	return {
		id: 1,
		name: "Engineering",
		states: [
			{ id: 500000001, name: "Backlog", type: "unstarted" },
			{ id: 500000002, name: "Ready for Development", type: "unstarted" },
			{ id: 500000003, name: "In Progress", type: "started" },
			{ id: 500000004, name: "Done", type: "done" },
		],
		...overrides,
	};
}

interface ShortcutWorkflowState {
	id: number;
	name: string;
	type: string;
}

function makeLabel(overrides: Partial<{ id: number; name: string; archived: boolean }> = {}) {
	return { id: 100, name: "lisa", color: null, archived: false, ...overrides };
}

interface ShortcutStoryLink {
	id: number;
	subject_id: number;
	object_id: number;
	verb: string;
}

function makeStory(
	overrides: Partial<{
		id: number;
		name: string;
		description: string;
		app_url: string;
		workflow_state_id: number;
		label_ids: number[];
		position: number;
		priority: number | null;
		story_links: ShortcutStoryLink[];
	}> = {},
) {
	return {
		id: 12345,
		name: "Fix the bug",
		description: "A description",
		app_url: "https://app.shortcut.com/workspace/story/12345/fix-the-bug",
		workflow_state_id: 500000002,
		label_ids: [100],
		position: 1000,
		priority: 2,
		story_links: [] as ShortcutStoryLink[],
		...overrides,
	};
}

type MockResponseItem =
	| { ok: boolean; status: number; data: unknown }
	| { ok: boolean; status: number; text: string };

function mockFetchSequence(responses: MockResponseItem[]) {
	let callIndex = 0;
	return vi.fn().mockImplementation(() => {
		const response = responses[callIndex++] ?? responses[responses.length - 1];
		if (!response) {
			throw new Error("No mock response available");
		}
		const r = response as { ok: boolean; status: number; data?: unknown; text?: string };
		return Promise.resolve({
			ok: r.ok,
			status: r.status,
			json: async () => r.data,
			text: async () => (r.text !== undefined ? r.text : JSON.stringify(r.data)),
		});
	});
}

function ok(data: unknown) {
	return { ok: true, status: 200, data };
}

function err(status: number, text = "Error") {
	return { ok: false, status, text };
}

const baseConfig = {
	team: "",
	project: "",
	label: "lisa",
	pick_from: "Ready for Development",
	in_progress: "In Progress",
	done: "Done",
};

// ---------------------------------------------------------------------------
// ShortcutSource
// ---------------------------------------------------------------------------

describe("ShortcutSource", () => {
	let source: ShortcutSource;

	beforeEach(() => {
		source = new ShortcutSource();
		process.env.SHORTCUT_API_TOKEN = "test-token";
	});

	afterEach(() => {
		delete process.env.SHORTCUT_API_TOKEN;
		vi.restoreAllMocks();
	});

	it("has correct name", () => {
		expect(source.name).toBe("shortcut");
	});

	// -------------------------------------------------------------------------
	// fetchNextIssue
	// -------------------------------------------------------------------------

	describe("fetchNextIssue", () => {
		it("returns null when no stories found", async () => {
			global.fetch = mockFetchSequence([
				ok([makeWorkflow()]), // GET /api/v3/workflows (resolve state IDs)
				ok([makeLabel()]), // GET /api/v3/labels
				ok([makeWorkflow()]), // GET /api/v3/workflows (resolve done states)
				ok({ data: [], next: null }), // POST /api/v3/stories/search
			]);

			const result = await source.fetchNextIssue(baseConfig);
			expect(result).toBeNull();
		});

		it("returns null when search returns empty data", async () => {
			global.fetch = mockFetchSequence([
				ok([makeWorkflow()]),
				ok([makeLabel()]),
				ok([makeWorkflow()]),
				ok({ data: [], next: null }),
			]);

			const result = await source.fetchNextIssue(baseConfig);
			expect(result).toBeNull();
		});

		it("returns an issue with correct shape", async () => {
			global.fetch = mockFetchSequence([
				ok([makeWorkflow()]),
				ok([makeLabel()]),
				ok([makeWorkflow()]),
				ok({ data: [makeStory({ id: 12345, name: "Fix the bug" })], next: null }),
			]);

			const result = await source.fetchNextIssue(baseConfig);
			expect(result).not.toBeNull();
			expect(result?.id).toBe("12345");
			expect(result?.title).toBe("Fix the bug");
			expect(result?.description).toBe("A description");
			expect(result?.url).toContain("12345");
		});

		it("sorts stories by priority ascending (lower number = higher priority)", async () => {
			const stories = [
				makeStory({ id: 1, name: "P3 story", priority: 3 }),
				makeStory({ id: 2, name: "P1 story", priority: 1 }),
				makeStory({ id: 3, name: "P2 story", priority: 2 }),
			];

			global.fetch = mockFetchSequence([
				ok([makeWorkflow()]),
				ok([makeLabel()]),
				ok([makeWorkflow()]),
				ok({ data: stories, next: null }),
			]);

			const result = await source.fetchNextIssue(baseConfig);
			expect(result?.title).toBe("P1 story");
		});

		it("treats null priority as lowest", async () => {
			const stories = [
				makeStory({ id: 1, name: "No priority", priority: null }),
				makeStory({ id: 2, name: "P4 story", priority: 4 }),
			];

			global.fetch = mockFetchSequence([
				ok([makeWorkflow()]),
				ok([makeLabel()]),
				ok([makeWorkflow()]),
				ok({ data: stories, next: null }),
			]);

			const result = await source.fetchNextIssue(baseConfig);
			expect(result?.title).toBe("P4 story");
		});

		it("falls back to position when priorities are equal", async () => {
			const stories = [
				makeStory({ id: 1, name: "Later story", priority: 2, position: 2000 }),
				makeStory({ id: 2, name: "Earlier story", priority: 2, position: 500 }),
			];

			global.fetch = mockFetchSequence([
				ok([makeWorkflow()]),
				ok([makeLabel()]),
				ok([makeWorkflow()]),
				ok({ data: stories, next: null }),
			]);

			const result = await source.fetchNextIssue(baseConfig);
			expect(result?.title).toBe("Earlier story");
		});

		it("throws when SHORTCUT_API_TOKEN is not set", async () => {
			delete process.env.SHORTCUT_API_TOKEN;
			await expect(source.fetchNextIssue(baseConfig)).rejects.toThrow(
				"SHORTCUT_API_TOKEN must be set",
			);
		});

		it("throws when workflow state not found", async () => {
			global.fetch = mockFetchSequence([
				ok([makeWorkflow({ states: [{ id: 1, name: "Backlog", type: "unstarted" }] })]),
			]);

			await expect(source.fetchNextIssue(baseConfig)).rejects.toThrow(
				'Shortcut workflow state "Ready for Development" not found',
			);
		});

		it("throws when label not found", async () => {
			global.fetch = mockFetchSequence([
				ok([makeWorkflow()]),
				ok([makeLabel({ name: "other-label" })]),
			]);

			await expect(source.fetchNextIssue(baseConfig)).rejects.toThrow(
				'Shortcut label "lisa" not found',
			);
		});

		it("skips archived labels when resolving", async () => {
			global.fetch = mockFetchSequence([
				ok([makeWorkflow()]),
				ok([makeLabel({ name: "lisa", archived: true })]),
			]);

			await expect(source.fetchNextIssue(baseConfig)).rejects.toThrow(
				'Shortcut label "lisa" not found',
			);
		});

		it("throws on API error", async () => {
			global.fetch = mockFetchSequence([err(401, "Unauthorized")]);
			await expect(source.fetchNextIssue(baseConfig)).rejects.toThrow("Shortcut API error (401)");
		});

		it("finds state across multiple workflows", async () => {
			const workflows = [
				makeWorkflow({
					id: 1,
					name: "Engineering",
					states: [{ id: 500000001, name: "Backlog", type: "unstarted" }],
				}),
				makeWorkflow({
					id: 2,
					name: "Design",
					states: [{ id: 500000010, name: "Ready for Development", type: "unstarted" }],
				}),
			];

			global.fetch = mockFetchSequence([
				ok(workflows),
				ok([makeLabel()]),
				ok(workflows),
				ok({ data: [makeStory()], next: null }),
			]);

			const result = await source.fetchNextIssue(baseConfig);
			expect(result).not.toBeNull();
		});

		it("skips blocked stories and returns unblocked one", async () => {
			const blockedStory = makeStory({
				id: 1,
				name: "Blocked story",
				story_links: [{ id: 1, subject_id: 999, object_id: 1, verb: "blocks" }],
			});
			const unblockedStory = makeStory({ id: 2, name: "Unblocked story" });
			// Blocker story is not in done state
			const blockerStory = makeStory({ id: 999, workflow_state_id: 500000003 });

			global.fetch = mockFetchSequence([
				ok([makeWorkflow()]), // resolve state IDs
				ok([makeLabel()]), // resolve label IDs
				ok([makeWorkflow()]), // resolve done states
				ok({ data: [blockedStory, unblockedStory], next: null }), // search
				ok(blockerStory), // fetch blocker story
			]);

			const result = await source.fetchNextIssue(baseConfig);
			expect(result?.title).toBe("Unblocked story");
		});

		it("returns null when all stories are blocked", async () => {
			const blockedStory = makeStory({
				id: 1,
				name: "Blocked story",
				story_links: [{ id: 1, subject_id: 999, object_id: 1, verb: "blocks" }],
			});
			const blockerStory = makeStory({ id: 999, workflow_state_id: 500000003 });

			global.fetch = mockFetchSequence([
				ok([makeWorkflow()]),
				ok([makeLabel()]),
				ok([makeWorkflow()]),
				ok({ data: [blockedStory], next: null }),
				ok(blockerStory),
			]);

			const result = await source.fetchNextIssue(baseConfig);
			expect(result).toBeNull();
		});

		it("ignores blockers in done state", async () => {
			const story = makeStory({
				id: 1,
				name: "Story with done blocker",
				story_links: [{ id: 1, subject_id: 999, object_id: 1, verb: "blocks" }],
			});
			// Blocker is in "Done" state (500000004)
			const blockerStory = makeStory({ id: 999, workflow_state_id: 500000004 });

			global.fetch = mockFetchSequence([
				ok([makeWorkflow()]),
				ok([makeLabel()]),
				ok([makeWorkflow()]),
				ok({ data: [story], next: null }),
				ok(blockerStory),
			]);

			const result = await source.fetchNextIssue(baseConfig);
			expect(result?.title).toBe("Story with done blocker");
		});

		it("respects priority among unblocked stories", async () => {
			const blockedP1 = makeStory({
				id: 1,
				name: "P1 blocked",
				priority: 1,
				story_links: [{ id: 1, subject_id: 999, object_id: 1, verb: "blocks" }],
			});
			const unblockedP3 = makeStory({ id: 2, name: "P3 unblocked", priority: 3 });
			const unblockedP2 = makeStory({ id: 3, name: "P2 unblocked", priority: 2 });
			const blockerStory = makeStory({ id: 999, workflow_state_id: 500000003 });

			global.fetch = mockFetchSequence([
				ok([makeWorkflow()]),
				ok([makeLabel()]),
				ok([makeWorkflow()]),
				ok({ data: [blockedP1, unblockedP3, unblockedP2], next: null }),
				ok(blockerStory),
			]);

			const result = await source.fetchNextIssue(baseConfig);
			expect(result?.title).toBe("P2 unblocked");
		});
	});

	// -------------------------------------------------------------------------
	// fetchIssueById
	// -------------------------------------------------------------------------

	describe("fetchIssueById", () => {
		it("fetches story by numeric ID", async () => {
			global.fetch = mockFetchSequence([ok(makeStory({ id: 12345, name: "Fix the bug" }))]);

			const result = await source.fetchIssueById("12345");
			expect(result?.title).toBe("Fix the bug");
			expect(result?.id).toBe("12345");
		});

		it("fetches story by Shortcut URL", async () => {
			global.fetch = mockFetchSequence([ok(makeStory({ id: 12345, name: "URL story" }))]);

			const result = await source.fetchIssueById(
				"https://app.shortcut.com/workspace/story/12345/fix-the-bug",
			);
			expect(result?.title).toBe("URL story");
			expect(result?.id).toBe("12345");
		});

		it("returns null on API error", async () => {
			global.fetch = mockFetchSequence([err(404, "Not Found")]);
			const result = await source.fetchIssueById("99999");
			expect(result).toBeNull();
		});
	});

	// -------------------------------------------------------------------------
	// updateStatus
	// -------------------------------------------------------------------------

	describe("updateStatus", () => {
		it("puts the story with the resolved workflow_state_id", async () => {
			let capturedUrl: string | undefined;
			let capturedBody: unknown;

			global.fetch = vi
				.fn()
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: async () => [makeWorkflow()],
					text: async () => "",
				})
				.mockImplementationOnce((url: string, init?: RequestInit) => {
					capturedUrl = url;
					capturedBody = JSON.parse(init?.body as string);
					return Promise.resolve({
						ok: true,
						status: 200,
						json: async () => makeStory(),
						text: async () => "",
					});
				});

			await source.updateStatus("12345", "In Progress");

			expect(capturedUrl).toContain("/api/v3/stories/12345");
			expect(capturedBody).toMatchObject({ workflow_state_id: 500000003 });
		});

		it("throws when state not found", async () => {
			global.fetch = mockFetchSequence([
				ok([makeWorkflow({ states: [{ id: 1, name: "Backlog", type: "unstarted" }] })]),
			]);

			await expect(source.updateStatus("12345", "Nonexistent State")).rejects.toThrow(
				'Shortcut workflow state "Nonexistent State" not found',
			);
		});
	});

	// -------------------------------------------------------------------------
	// attachPullRequest
	// -------------------------------------------------------------------------

	describe("attachPullRequest", () => {
		it("posts a comment with the PR URL", async () => {
			let capturedUrl: string | undefined;
			let capturedBody: unknown;

			global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
				capturedUrl = url;
				capturedBody = JSON.parse(init?.body as string);
				return Promise.resolve({
					ok: true,
					status: 201,
					json: async () => ({ id: 1, text: "" }),
					text: async () => "",
				});
			});

			await source.attachPullRequest("12345", "https://github.com/org/repo/pull/42");

			expect(capturedUrl).toContain("/api/v3/stories/12345/comments");
			expect((capturedBody as { text: string }).text).toContain(
				"https://github.com/org/repo/pull/42",
			);
		});
	});

	// -------------------------------------------------------------------------
	// completeIssue
	// -------------------------------------------------------------------------

	describe("completeIssue", () => {
		it("updates status and removes label", async () => {
			const calls: string[] = [];

			global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
				const method = init?.method ?? "GET";
				calls.push(`${method} ${url}`);

				// GET /api/v3/workflows for updateStatus
				if (method === "GET" && url.includes("/workflows")) {
					return Promise.resolve({
						ok: true,
						status: 200,
						json: async () => [makeWorkflow()],
						text: async () => "",
					});
				}

				// PUT for updateStatus
				if (method === "PUT" && url.includes("/stories/12345") && !url.includes("/comments")) {
					const body = JSON.parse(init?.body as string);
					if ("workflow_state_id" in body) {
						return Promise.resolve({
							ok: true,
							status: 200,
							json: async () => makeStory({ workflow_state_id: 500000004 }),
							text: async () => "",
						});
					}
					// PUT for removeLabel
					return Promise.resolve({
						ok: true,
						status: 200,
						json: async () => makeStory({ label_ids: [] }),
						text: async () => "",
					});
				}

				// GET /api/v3/stories/12345 for removeLabel
				if (method === "GET" && url.includes("/stories/12345")) {
					return Promise.resolve({
						ok: true,
						status: 200,
						json: async () => makeStory({ label_ids: [100] }),
						text: async () => "",
					});
				}

				// GET /api/v3/labels for removeLabel
				if (method === "GET" && url.includes("/labels")) {
					return Promise.resolve({
						ok: true,
						status: 200,
						json: async () => [makeLabel()],
						text: async () => "",
					});
				}

				return Promise.resolve({
					ok: true,
					status: 200,
					json: async () => ({}),
					text: async () => "",
				});
			});

			await source.completeIssue("12345", "Done", "lisa");

			const putCalls = calls.filter((c) => c.startsWith("PUT"));
			expect(putCalls.length).toBeGreaterThanOrEqual(1);
		});

		it("only updates status when no labelToRemove provided", async () => {
			const fetchMock = vi
				.fn()
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: async () => [makeWorkflow()],
					text: async () => "",
				})
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: async () => makeStory(),
					text: async () => "",
				});

			global.fetch = fetchMock;

			await source.completeIssue("12345", "Done");

			expect(fetchMock).toHaveBeenCalledTimes(2); // GET workflows + PUT story
		});
	});

	// -------------------------------------------------------------------------
	// listIssues
	// -------------------------------------------------------------------------

	describe("listIssues", () => {
		it("returns all stories with the configured label and status", async () => {
			const stories = [
				makeStory({ id: 1, name: "First story" }),
				makeStory({ id: 2, name: "Second story" }),
			];

			global.fetch = mockFetchSequence([
				ok([makeWorkflow()]),
				ok([makeLabel()]),
				ok({ data: stories, next: null }),
			]);

			const result = await source.listIssues(baseConfig);
			expect(result).toHaveLength(2);
			expect(result[0]).toMatchObject({ id: "1", title: "First story" });
			expect(result[1]).toMatchObject({ id: "2", title: "Second story" });
		});

		it("returns empty array when no stories found", async () => {
			global.fetch = mockFetchSequence([
				ok([makeWorkflow()]),
				ok([makeLabel()]),
				ok({ data: [], next: null }),
			]);

			const result = await source.listIssues(baseConfig);
			expect(result).toEqual([]);
		});
	});

	// -------------------------------------------------------------------------
	// removeLabel
	// -------------------------------------------------------------------------

	describe("removeLabel", () => {
		it("removes the specified label from the story", async () => {
			let capturedBody: unknown;

			global.fetch = vi
				.fn()
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: async () => makeStory({ label_ids: [100, 200] }),
					text: async () => "",
				})
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: async () => [
						makeLabel({ id: 100, name: "lisa" }),
						makeLabel({ id: 200, name: "wip" }),
					],
					text: async () => "",
				})
				.mockImplementationOnce((_url: string, init?: RequestInit) => {
					capturedBody = JSON.parse(init?.body as string);
					return Promise.resolve({
						ok: true,
						status: 200,
						json: async () => makeStory({ label_ids: [200] }),
						text: async () => "",
					});
				});

			await source.removeLabel("12345", "lisa");

			expect((capturedBody as { label_ids: number[] }).label_ids).toEqual([200]);
		});

		it("skips API call if label is not on the story", async () => {
			const fetchMock = vi
				.fn()
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: async () => makeStory({ label_ids: [200] }), // label 100 not present
					text: async () => "",
				})
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: async () => [makeLabel({ id: 100, name: "lisa" })],
					text: async () => "",
				});

			global.fetch = fetchMock;

			await source.removeLabel("12345", "lisa");

			// Only 2 GET calls, no PUT
			expect(fetchMock).toHaveBeenCalledTimes(2);
		});

		it("is case-insensitive when matching label name", async () => {
			let capturedBody: unknown;

			global.fetch = vi
				.fn()
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: async () => makeStory({ label_ids: [100] }),
					text: async () => "",
				})
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: async () => [makeLabel({ id: 100, name: "Lisa" })], // uppercase
					text: async () => "",
				})
				.mockImplementationOnce((_url: string, init?: RequestInit) => {
					capturedBody = JSON.parse(init?.body as string);
					return Promise.resolve({
						ok: true,
						status: 200,
						json: async () => makeStory({ label_ids: [] }),
						text: async () => "",
					});
				});

			await source.removeLabel("12345", "lisa");

			expect((capturedBody as { label_ids: number[] }).label_ids).toEqual([]);
		});

		it("skips archived labels when finding label to remove", async () => {
			const fetchMock = vi
				.fn()
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: async () => makeStory({ label_ids: [100] }),
					text: async () => "",
				})
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: async () => [makeLabel({ id: 100, name: "lisa", archived: true })],
					text: async () => "",
				});

			global.fetch = fetchMock;

			await source.removeLabel("12345", "lisa");

			// No PUT since archived label is skipped
			expect(fetchMock).toHaveBeenCalledTimes(2);
		});
	});
});
