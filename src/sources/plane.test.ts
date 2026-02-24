import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlaneSource, parsePlaneIssueId } from "./plane.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeProject(overrides: Partial<{ id: string; name: string; identifier: string }> = {}) {
	return { id: "project-uuid-1", name: "My Project", identifier: "DEV", ...overrides };
}

function makeState(overrides: Partial<{ id: string; name: string }> = {}) {
	return {
		id: "state-uuid-1",
		name: "Todo",
		color: "#ff0000",
		sequence: 10000,
		group: "unstarted",
		...overrides,
	};
}

function makeLabel(overrides: Partial<{ id: string; name: string }> = {}) {
	return { id: "label-uuid-1", name: "ready", color: "#00ff00", ...overrides };
}

function makeIssue(
	overrides: Partial<{
		id: string;
		name: string;
		description_stripped: string | null;
		priority: string;
		state: string;
		label_ids: string[];
		sequence_id: number;
		project: string;
	}> = {},
) {
	return {
		id: "issue-uuid-1",
		name: "Fix bug",
		description_stripped: "Some description",
		priority: "medium",
		state: "state-uuid-1",
		label_ids: ["label-uuid-1"],
		sequence_id: 1,
		project: "project-uuid-1",
		...overrides,
	};
}

function makePage<T>(results: T[]) {
	return { count: results.length, next: null, previous: null, results };
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
	team: "my-workspace",
	project: "DEV",
	label: "ready",
	pick_from: "Todo",
	in_progress: "In Progress",
	done: "Done",
};

// ---------------------------------------------------------------------------
// parsePlaneIssueId
// ---------------------------------------------------------------------------

describe("parsePlaneIssueId", () => {
	it("parses a Plane web URL", () => {
		const result = parsePlaneIssueId(
			"https://app.plane.so/my-workspace/projects/proj-uuid/issues/issue-uuid",
		);
		expect(result).toEqual({
			workspaceSlug: "my-workspace",
			projectId: "proj-uuid",
			issueId: "issue-uuid",
		});
	});

	it("parses a self-hosted Plane URL", () => {
		const result = parsePlaneIssueId(
			"https://plane.mycompany.so/workspace/projects/proj-uuid/issues/issue-uuid",
		);
		expect(result).toEqual({
			workspaceSlug: "workspace",
			projectId: "proj-uuid",
			issueId: "issue-uuid",
		});
	});

	it("parses composite format workspace::projectId::issueId", () => {
		const result = parsePlaneIssueId("my-workspace::project-uuid::issue-uuid");
		expect(result).toEqual({
			workspaceSlug: "my-workspace",
			projectId: "project-uuid",
			issueId: "issue-uuid",
		});
	});

	it("returns null for invalid format", () => {
		const result = parsePlaneIssueId("invalid-id");
		expect(result).toBeNull();
	});

	it("returns null for partial composite format", () => {
		const result = parsePlaneIssueId("workspace::project");
		expect(result).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// PlaneSource
// ---------------------------------------------------------------------------

describe("PlaneSource", () => {
	let source: PlaneSource;

	beforeEach(() => {
		source = new PlaneSource();
		process.env.PLANE_API_TOKEN = "test-token";
		process.env.PLANE_BASE_URL = "https://api.plane.so";
	});

	afterEach(() => {
		delete process.env.PLANE_API_TOKEN;
		delete process.env.PLANE_BASE_URL;
		vi.restoreAllMocks();
	});

	// -------------------------------------------------------------------------
	// name
	// -------------------------------------------------------------------------

	it("has correct name", () => {
		expect(source.name).toBe("plane");
	});

	// -------------------------------------------------------------------------
	// fetchNextIssue
	// -------------------------------------------------------------------------

	describe("fetchNextIssue", () => {
		it("returns null when no matching issues found", async () => {
			global.fetch = mockFetchSequence([
				ok(makePage([makeProject()])), // resolveProject
				ok([makeState()]), // resolveState
				ok([makeLabel()]), // resolveLabel
				ok(makePage([])), // fetch issues
			]);

			const result = await source.fetchNextIssue(baseConfig);
			expect(result).toBeNull();
		});

		it("returns null when issues exist but none match the label", async () => {
			global.fetch = mockFetchSequence([
				ok(makePage([makeProject()])),
				ok([makeState()]),
				ok([makeLabel()]),
				ok(makePage([makeIssue({ label_ids: ["other-label-id"] })])),
			]);

			const result = await source.fetchNextIssue(baseConfig);
			expect(result).toBeNull();
		});

		it("returns an issue with correct shape", async () => {
			global.fetch = mockFetchSequence([
				ok(makePage([makeProject()])),
				ok([makeState()]),
				ok([makeLabel()]),
				ok(makePage([makeIssue({ id: "issue-uuid-1", name: "Fix bug" })])),
			]);

			const result = await source.fetchNextIssue(baseConfig);
			expect(result).not.toBeNull();
			expect(result?.id).toBe("my-workspace::project-uuid-1::issue-uuid-1");
			expect(result?.title).toBe("Fix bug");
			expect(result?.description).toBe("Some description");
			expect(result?.url).toContain("issue-uuid-1");
		});

		it("sorts issues by priority: urgent first", async () => {
			const issues = [
				makeIssue({ id: "id-low", name: "Low issue", priority: "low" }),
				makeIssue({ id: "id-urgent", name: "Urgent issue", priority: "urgent" }),
				makeIssue({ id: "id-medium", name: "Medium issue", priority: "medium" }),
			];

			global.fetch = mockFetchSequence([
				ok(makePage([makeProject()])),
				ok([makeState()]),
				ok([makeLabel()]),
				ok(makePage(issues)),
			]);

			const result = await source.fetchNextIssue(baseConfig);
			expect(result?.title).toBe("Urgent issue");
		});

		it("treats 'none' priority as lowest", async () => {
			const issues = [
				makeIssue({ id: "id-none", name: "No priority issue", priority: "none" }),
				makeIssue({ id: "id-low", name: "Low issue", priority: "low" }),
			];

			global.fetch = mockFetchSequence([
				ok(makePage([makeProject()])),
				ok([makeState()]),
				ok([makeLabel()]),
				ok(makePage(issues)),
			]);

			const result = await source.fetchNextIssue(baseConfig);
			expect(result?.title).toBe("Low issue");
		});

		it("handles null description_stripped", async () => {
			global.fetch = mockFetchSequence([
				ok(makePage([makeProject()])),
				ok([makeState()]),
				ok([makeLabel()]),
				ok(makePage([makeIssue({ description_stripped: null })])),
			]);

			const result = await source.fetchNextIssue(baseConfig);
			expect(result?.description).toBe("");
		});

		it("throws when PLANE_API_TOKEN is not set", async () => {
			delete process.env.PLANE_API_TOKEN;
			await expect(source.fetchNextIssue(baseConfig)).rejects.toThrow(
				"PLANE_API_TOKEN must be set",
			);
		});

		it("throws when project not found", async () => {
			global.fetch = mockFetchSequence([ok(makePage([makeProject({ identifier: "OTHER" })]))]); // no DEV project

			await expect(source.fetchNextIssue(baseConfig)).rejects.toThrow(
				'Plane project "DEV" not found',
			);
		});

		it("throws when state not found", async () => {
			global.fetch = mockFetchSequence([
				ok(makePage([makeProject()])),
				ok([makeState({ name: "Doing" })]), // no 'Todo' state
			]);

			await expect(source.fetchNextIssue(baseConfig)).rejects.toThrow(
				'Plane state "Todo" not found',
			);
		});

		it("throws when label not found", async () => {
			global.fetch = mockFetchSequence([
				ok(makePage([makeProject()])),
				ok([makeState()]),
				ok([makeLabel({ name: "wip" })]), // no 'ready' label
			]);

			await expect(source.fetchNextIssue(baseConfig)).rejects.toThrow(
				'Plane label "ready" not found',
			);
		});

		it("throws on API error", async () => {
			global.fetch = mockFetchSequence([err(401, "Unauthorized")]);
			await expect(source.fetchNextIssue(baseConfig)).rejects.toThrow("Plane API error (401)");
		});

		it("resolves project by name if identifier doesn't match", async () => {
			const configByName = { ...baseConfig, project: "My Project" };

			global.fetch = mockFetchSequence([
				ok(makePage([makeProject()])), // identifier is "DEV", name is "My Project"
				ok([makeState()]),
				ok([makeLabel()]),
				ok(makePage([makeIssue()])),
			]);

			const result = await source.fetchNextIssue(configByName);
			expect(result).not.toBeNull();
		});

		it("resolves project by UUID if provided directly", async () => {
			const configByUuid = { ...baseConfig, project: "project-uuid-1" };

			global.fetch = mockFetchSequence([
				ok(makePage([makeProject()])),
				ok([makeState()]),
				ok([makeLabel()]),
				ok(makePage([makeIssue()])),
			]);

			const result = await source.fetchNextIssue(configByUuid);
			expect(result).not.toBeNull();
		});
	});

	// -------------------------------------------------------------------------
	// fetchIssueById
	// -------------------------------------------------------------------------

	describe("fetchIssueById", () => {
		it("fetches by composite ID", async () => {
			global.fetch = mockFetchSequence([ok(makeIssue({ id: "issue-uuid-1", name: "Fix bug" }))]);

			const result = await source.fetchIssueById("my-workspace::project-uuid-1::issue-uuid-1");
			expect(result?.title).toBe("Fix bug");
			expect(result?.id).toBe("my-workspace::project-uuid-1::issue-uuid-1");
		});

		it("fetches by Plane URL", async () => {
			global.fetch = mockFetchSequence([ok(makeIssue({ id: "issue-uuid-1", name: "URL issue" }))]);

			const result = await source.fetchIssueById(
				"https://app.plane.so/my-workspace/projects/project-uuid-1/issues/issue-uuid-1",
			);
			expect(result?.title).toBe("URL issue");
		});

		it("returns null on API error", async () => {
			global.fetch = mockFetchSequence([err(404, "Not Found")]);
			const result = await source.fetchIssueById("my-workspace::project-uuid-1::issue-uuid-999");
			expect(result).toBeNull();
		});

		it("returns null on invalid ID format", async () => {
			global.fetch = vi.fn();
			const result = await source.fetchIssueById("invalid-id");
			expect(result).toBeNull();
		});
	});

	// -------------------------------------------------------------------------
	// updateStatus
	// -------------------------------------------------------------------------

	describe("updateStatus", () => {
		it("patches the issue with the resolved state ID", async () => {
			let capturedUrl: string | undefined;
			let capturedBody: unknown;

			global.fetch = vi
				.fn()
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: async () => [makeState({ id: "state-in-progress", name: "In Progress" })],
					text: async () => "",
				})
				.mockImplementationOnce((url: string, init?: RequestInit) => {
					capturedUrl = url;
					capturedBody = JSON.parse(init?.body as string);
					return Promise.resolve({
						ok: true,
						status: 200,
						json: async () => makeIssue(),
						text: async () => "",
					});
				});

			await source.updateStatus("my-workspace::project-uuid-1::issue-uuid-1", "In Progress");

			expect(capturedUrl).toContain("/issues/issue-uuid-1/");
			expect(capturedBody).toMatchObject({ state: "state-in-progress" });
		});

		it("throws when state not found", async () => {
			global.fetch = mockFetchSequence([ok([makeState({ name: "Doing" })])]);

			await expect(
				source.updateStatus("my-workspace::project-uuid-1::issue-uuid-1", "In Progress"),
			).rejects.toThrow('Plane state "In Progress" not found');
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
					json: async () => ({ id: "comment-1", comment_html: "" }),
					text: async () => "",
				});
			});

			await source.attachPullRequest(
				"my-workspace::project-uuid-1::issue-uuid-1",
				"https://github.com/org/repo/pull/42",
			);

			expect(capturedUrl).toContain("/comments/");
			expect((capturedBody as { comment_html: string }).comment_html).toContain(
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
				calls.push(`${init?.method ?? "GET"} ${url}`);

				// resolveState (GET)
				if (
					(init?.method === "GET" || !init?.method) &&
					url.includes("/states/") &&
					!url.includes("/issues/")
				) {
					return Promise.resolve({
						ok: true,
						status: 200,
						json: async () => [makeState({ id: "state-done", name: "Done" })],
						text: async () => "",
					});
				}

				// updateStatus PATCH
				if (init?.method === "PATCH" && url.includes("/issues/issue-uuid-1/")) {
					const body = JSON.parse(init.body as string);
					// First PATCH is state update
					if ("state" in body) {
						return Promise.resolve({
							ok: true,
							status: 200,
							json: async () => makeIssue({ state: "state-done" }),
							text: async () => "",
						});
					}
					// Second PATCH is label update
					return Promise.resolve({
						ok: true,
						status: 200,
						json: async () => makeIssue({ label_ids: [] }),
						text: async () => "",
					});
				}

				// GET issue for removeLabel
				if ((init?.method === "GET" || !init?.method) && url.includes("/issues/issue-uuid-1/")) {
					return Promise.resolve({
						ok: true,
						status: 200,
						json: async () => makeIssue({ label_ids: ["label-uuid-1"] }),
						text: async () => "",
					});
				}

				// GET labels
				if (
					(init?.method === "GET" || !init?.method) &&
					url.includes("/labels/") &&
					!url.includes("/issues/")
				) {
					return Promise.resolve({
						ok: true,
						status: 200,
						json: async () => [makeLabel({ id: "label-uuid-1", name: "ready" })],
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

			await source.completeIssue("my-workspace::project-uuid-1::issue-uuid-1", "Done", "ready");

			const patchCalls = calls.filter((c) => c.startsWith("PATCH"));
			expect(patchCalls.length).toBeGreaterThanOrEqual(1);
		});

		it("only updates status when no labelToRemove provided", async () => {
			const fetchMock = vi
				.fn()
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: async () => [makeState({ id: "state-done", name: "Done" })],
					text: async () => "",
				})
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: async () => makeIssue({ state: "state-done" }),
					text: async () => "",
				});

			global.fetch = fetchMock;

			await source.completeIssue("my-workspace::project-uuid-1::issue-uuid-1", "Done");

			expect(fetchMock).toHaveBeenCalledTimes(2); // resolveState + PATCH
		});
	});

	// -------------------------------------------------------------------------
	// removeLabel
	// -------------------------------------------------------------------------

	describe("removeLabel", () => {
		it("removes the specified label from the issue", async () => {
			let capturedBody: unknown;

			global.fetch = vi
				.fn()
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: async () => makeIssue({ label_ids: ["label-uuid-1", "label-uuid-2"] }),
					text: async () => "",
				})
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: async () => [
						makeLabel({ id: "label-uuid-1", name: "ready" }),
						makeLabel({ id: "label-uuid-2", name: "wip" }),
					],
					text: async () => "",
				})
				.mockImplementationOnce((_url: string, init?: RequestInit) => {
					capturedBody = JSON.parse(init?.body as string);
					return Promise.resolve({
						ok: true,
						status: 200,
						json: async () => makeIssue({ label_ids: ["label-uuid-2"] }),
						text: async () => "",
					});
				});

			await source.removeLabel("my-workspace::project-uuid-1::issue-uuid-1", "ready");

			expect((capturedBody as { label_ids: string[] }).label_ids).toEqual(["label-uuid-2"]);
		});

		it("skips API call if label is not on the issue", async () => {
			const fetchMock = vi
				.fn()
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: async () => makeIssue({ label_ids: ["label-uuid-2"] }),
					text: async () => "",
				})
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: async () => [makeLabel({ id: "label-uuid-1", name: "ready" })],
					text: async () => "",
				});

			global.fetch = fetchMock;

			await source.removeLabel("my-workspace::project-uuid-1::issue-uuid-1", "ready");

			// Only 2 GET calls, no PATCH
			expect(fetchMock).toHaveBeenCalledTimes(2);
		});

		it("is case-insensitive when matching label name", async () => {
			let capturedBody: unknown;

			global.fetch = vi
				.fn()
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: async () => makeIssue({ label_ids: ["label-uuid-1"] }),
					text: async () => "",
				})
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: async () => [makeLabel({ id: "label-uuid-1", name: "Ready" })],
					text: async () => "",
				})
				.mockImplementationOnce((_url: string, init?: RequestInit) => {
					capturedBody = JSON.parse(init?.body as string);
					return Promise.resolve({
						ok: true,
						status: 200,
						json: async () => makeIssue({ label_ids: [] }),
						text: async () => "",
					});
				});

			await source.removeLabel("my-workspace::project-uuid-1::issue-uuid-1", "ready");

			expect((capturedBody as { label_ids: string[] }).label_ids).toEqual([]);
		});
	});

	// -------------------------------------------------------------------------
	// listIssues
	// -------------------------------------------------------------------------

	describe("listIssues", () => {
		it("returns all issues with the configured label and status", async () => {
			const issues = [
				makeIssue({ id: "issue-uuid-1", name: "First issue" }),
				makeIssue({ id: "issue-uuid-2", name: "Second issue" }),
			];

			global.fetch = mockFetchSequence([
				ok(makePage([makeProject()])),
				ok([makeState()]),
				ok([makeLabel()]),
				ok(makePage(issues)),
			]);

			const result = await source.listIssues(baseConfig);
			expect(result).toHaveLength(2);
			expect(result[0]).toMatchObject({ title: "First issue" });
			expect(result[1]).toMatchObject({ title: "Second issue" });
		});

		it("returns empty array when no issues match the label", async () => {
			global.fetch = mockFetchSequence([
				ok(makePage([makeProject()])),
				ok([makeState()]),
				ok([makeLabel()]),
				ok(makePage([makeIssue({ label_ids: ["other-label-id"] })])),
			]);

			const result = await source.listIssues(baseConfig);
			expect(result).toEqual([]);
		});

		it("returns empty array when no issues exist", async () => {
			global.fetch = mockFetchSequence([
				ok(makePage([makeProject()])),
				ok([makeState()]),
				ok([makeLabel()]),
				ok(makePage([])),
			]);

			const result = await source.listIssues(baseConfig);
			expect(result).toEqual([]);
		});
	});

	// -------------------------------------------------------------------------
	// App URL generation
	// -------------------------------------------------------------------------

	describe("app URL", () => {
		it("uses app.plane.so for default cloud API URL", async () => {
			global.fetch = mockFetchSequence([
				ok(makePage([makeProject()])),
				ok([makeState()]),
				ok([makeLabel()]),
				ok(makePage([makeIssue({ id: "issue-uuid-1" })])),
			]);

			const result = await source.fetchNextIssue(baseConfig);
			expect(result?.url).toContain("app.plane.so");
		});

		it("uses custom base URL for self-hosted instances", async () => {
			process.env.PLANE_BASE_URL = "https://plane.mycompany.com";

			global.fetch = mockFetchSequence([
				ok(makePage([makeProject()])),
				ok([makeState()]),
				ok([makeLabel()]),
				ok(makePage([makeIssue({ id: "issue-uuid-1" })])),
			]);

			const result = await source.fetchNextIssue(baseConfig);
			expect(result?.url).toContain("plane.mycompany.com");
		});
	});
});
