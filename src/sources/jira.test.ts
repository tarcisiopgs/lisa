import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JiraSource } from "./jira.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface JiraIssueLink {
	type: { name: string; inward: string; outward: string };
	inwardIssue?: {
		key: string;
		fields: { status: { name: string; statusCategory: { key: string } } };
	};
	outwardIssue?: {
		key: string;
		fields: { status: { name: string; statusCategory: { key: string } } };
	};
}

function makeIssue(
	overrides: Partial<{
		id: string;
		key: string;
		priorityName: string | null;
		summary: string;
		description: unknown;
		labels: string[];
		statusName: string;
		issuelinks: JiraIssueLink[];
	}> = {},
): JiraIssue {
	return {
		id: overrides.id ?? "10001",
		key: overrides.key ?? "ENG-1",
		self: "https://example.atlassian.net/rest/api/3/issue/10001",
		fields: {
			summary: overrides.summary ?? "Fix the bug",
			description: overrides.description ?? null,
			priority:
				overrides.priorityName !== null ? { name: overrides.priorityName ?? "Medium" } : null,
			status: { name: overrides.statusName ?? "Backlog" },
			labels: overrides.labels ?? ["lisa"],
			issuelinks: overrides.issuelinks ?? [],
		},
	};
}

interface JiraIssue {
	id: string;
	key: string;
	self: string;
	fields: {
		summary: string;
		description: unknown;
		priority: { name: string } | null;
		status: { name: string };
		labels: string[];
		issuelinks?: JiraIssueLink[];
	};
}

function makeTransitions(
	names: string[] = ["In Progress", "Done", "Backlog"],
	opts?: { transitionNames?: string[] },
): {
	transitions: { id: string; name: string; to: { id: string; name: string } }[];
} {
	return {
		transitions: names.map((name, i) => ({
			id: String(i + 1),
			name: opts?.transitionNames?.[i] ?? name,
			to: { id: String(10000 + i), name },
		})),
	};
}

type MockResponseItem =
	| { ok: boolean; status: number; data: unknown }
	| { ok: boolean; status: number; text: string };

function mockFetchSequence(responses: MockResponseItem[]) {
	let callIndex = 0;
	return vi.fn().mockImplementation(() => {
		const response = responses[callIndex++] ?? responses[responses.length - 1];
		if (!response) throw new Error("No mock response available");
		const r = response as { ok: boolean; status: number; data?: unknown; text?: string };
		return Promise.resolve({
			ok: r.ok,
			status: r.status,
			json: async () => r.data,
			text: async () => (r.text !== undefined ? r.text : JSON.stringify(r.data)),
		});
	});
}

function ok(data: unknown, status = 200) {
	return { ok: true, status, data };
}

function _noContent() {
	return { ok: true, status: 204, data: undefined };
}

function err(status: number, text = "Error") {
	return { ok: false, status, text };
}

const baseConfig = {
	scope: "ENG",
	project: "",
	label: "lisa",
	pick_from: "Backlog",
	in_progress: "In Progress",
	done: "Done",
};

// ---------------------------------------------------------------------------
// JiraSource
// ---------------------------------------------------------------------------

describe("JiraSource", () => {
	let source: JiraSource;

	beforeEach(() => {
		source = new JiraSource();
		process.env.JIRA_BASE_URL = "https://example.atlassian.net";
		process.env.JIRA_EMAIL = "user@example.com";
		process.env.JIRA_API_TOKEN = "test-token";
	});

	afterEach(() => {
		delete process.env.JIRA_BASE_URL;
		delete process.env.JIRA_EMAIL;
		delete process.env.JIRA_API_TOKEN;
		vi.restoreAllMocks();
	});

	it("has correct name", () => {
		expect(source.name).toBe("jira");
	});

	// -------------------------------------------------------------------------
	// fetchNextIssue
	// -------------------------------------------------------------------------

	describe("fetchNextIssue", () => {
		// Helper: mock for resolveStatusId call (GET /project/ENG/statuses)
		const statusesResponse = ok([
			{
				statuses: [
					{ id: "10001", name: "Backlog" },
					{ id: "10002", name: "In Progress" },
					{ id: "10003", name: "Done" },
				],
			},
		]);

		it("returns null when no issues found", async () => {
			global.fetch = mockFetchSequence([statusesResponse, ok({ issues: [], total: 0 })]);
			const result = await source.fetchNextIssue(baseConfig);
			expect(result).toBeNull();
		});

		it("returns an issue with correct shape", async () => {
			global.fetch = mockFetchSequence([
				statusesResponse,
				ok({ issues: [makeIssue({ key: "ENG-1", summary: "Fix the bug" })], total: 1 }),
			]);

			const result = await source.fetchNextIssue(baseConfig);
			expect(result).not.toBeNull();
			expect(result?.id).toBe("ENG-1");
			expect(result?.title).toBe("Fix the bug");
			expect(result?.url).toBe("https://example.atlassian.net/browse/ENG-1");
		});

		it("sorts issues by priority (Highest first)", async () => {
			const issues = [
				makeIssue({ key: "ENG-1", summary: "Low priority", priorityName: "Low" }),
				makeIssue({ key: "ENG-2", summary: "Highest priority", priorityName: "Highest" }),
				makeIssue({ key: "ENG-3", summary: "Medium priority", priorityName: "Medium" }),
			];
			global.fetch = mockFetchSequence([statusesResponse, ok({ issues, total: 3 })]);

			const result = await source.fetchNextIssue(baseConfig);
			expect(result?.title).toBe("Highest priority");
		});

		it("treats null priority as lowest priority", async () => {
			const issues = [
				makeIssue({ key: "ENG-1", summary: "No priority", priorityName: null }),
				makeIssue({ key: "ENG-2", summary: "Low priority", priorityName: "Low" }),
			];
			global.fetch = mockFetchSequence([statusesResponse, ok({ issues, total: 2 })]);

			const result = await source.fetchNextIssue(baseConfig);
			expect(result?.title).toBe("Low priority");
		});

		it("extracts description from plain string", async () => {
			global.fetch = mockFetchSequence([
				statusesResponse,
				ok({
					issues: [makeIssue({ description: "Plain text description" })],
					total: 1,
				}),
			]);

			const result = await source.fetchNextIssue(baseConfig);
			expect(result?.description).toBe("Plain text description");
		});

		it("extracts description from ADF document format", async () => {
			const adfDoc = {
				type: "doc",
				content: [
					{
						type: "paragraph",
						content: [{ type: "text", text: "First paragraph" }],
					},
					{
						type: "paragraph",
						content: [{ type: "text", text: "Second paragraph" }],
					},
				],
			};
			global.fetch = mockFetchSequence([
				statusesResponse,
				ok({ issues: [makeIssue({ description: adfDoc })], total: 1 }),
			]);

			const result = await source.fetchNextIssue(baseConfig);
			expect(result?.description).toContain("First paragraph");
			expect(result?.description).toContain("Second paragraph");
		});

		it("returns empty description when description is null", async () => {
			global.fetch = mockFetchSequence([
				statusesResponse,
				ok({ issues: [makeIssue({ description: null })], total: 1 }),
			]);

			const result = await source.fetchNextIssue(baseConfig);
			expect(result?.description).toBe("");
		});

		it("throws when JIRA_BASE_URL is not set", async () => {
			delete process.env.JIRA_BASE_URL;
			await expect(source.fetchNextIssue(baseConfig)).rejects.toThrow("JIRA_BASE_URL is not set");
		});

		it("throws when JIRA_EMAIL is not set", async () => {
			delete process.env.JIRA_EMAIL;
			await expect(source.fetchNextIssue(baseConfig)).rejects.toThrow(
				"JIRA_EMAIL and JIRA_API_TOKEN must be set",
			);
		});

		it("throws when JIRA_API_TOKEN is not set", async () => {
			delete process.env.JIRA_API_TOKEN;
			await expect(source.fetchNextIssue(baseConfig)).rejects.toThrow(
				"JIRA_EMAIL and JIRA_API_TOKEN must be set",
			);
		});

		it("throws on API error", async () => {
			global.fetch = mockFetchSequence([err(401, "Unauthorized")]);
			await expect(source.fetchNextIssue(baseConfig)).rejects.toThrow("Jira API error (401)");
		});

		it("sends correct JQL query via POST with status ID", async () => {
			const capturedCalls: { url: string; body?: string }[] = [];
			global.fetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
				capturedCalls.push({ url, body: opts?.body as string | undefined });
				// First call: GET /project/ENG/statuses
				if (url.includes("/project/") && url.includes("/statuses")) {
					return Promise.resolve({
						ok: true,
						status: 200,
						json: async () => [
							{
								statuses: [
									{ id: "10001", name: "Backlog" },
									{ id: "10002", name: "In Progress" },
								],
							},
						],
						text: async () => "",
					});
				}
				return Promise.resolve({
					ok: true,
					status: 200,
					json: async () => ({ issues: [], total: 0 }),
					text: async () => "",
				});
			});

			await source.fetchNextIssue(baseConfig);

			const searchCall = capturedCalls.find((c) => c.url.includes("/search/jql"));
			expect(searchCall).toBeDefined();
			const body = JSON.parse(searchCall!.body ?? "{}") as { jql: string };
			expect(body.jql).toContain(`project = "ENG"`);
			expect(body.jql).toContain(`labels = "lisa"`);
			// Uses numeric status ID instead of quoted name
			expect(body.jql).toContain("status = 10001");
		});

		it("escapes special characters in JQL values", async () => {
			const capturedCalls: { url: string; body?: string }[] = [];
			global.fetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
				capturedCalls.push({ url, body: opts?.body as string | undefined });
				if (url.includes("/project/") && url.includes("/statuses")) {
					return Promise.resolve({
						ok: true,
						status: 200,
						json: async () => [
							{
								statuses: [{ id: "10001", name: 'Back"log' }],
							},
						],
						text: async () => "",
					});
				}
				return Promise.resolve({
					ok: true,
					status: 200,
					json: async () => ({ issues: [], total: 0 }),
					text: async () => "",
				});
			});

			await source.fetchNextIssue({
				...baseConfig,
				scope: "ENG'S",
				label: "lisa\nnewline",
				pick_from: 'Back"log',
			});

			const searchCall = capturedCalls.find((c) => c.url.includes("/search/jql"));
			expect(searchCall).toBeDefined();
			const body = JSON.parse(searchCall!.body ?? "{}") as { jql: string };
			// Single quotes are escaped
			expect(body.jql).toContain(`project = "ENG\\'S"`);
			// Newlines are replaced with spaces
			expect(body.jql).toContain(`labels = "lisa newline"`);
			// Uses numeric status ID (so no escaped quotes in status clause)
			expect(body.jql).toContain("status = 10001");
		});

		it("escapes single quotes and control chars in status name fallback", async () => {
			const capturedCalls: { url: string; body?: string }[] = [];
			global.fetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
				capturedCalls.push({ url, body: opts?.body as string | undefined });
				if (url.includes("/project/") && url.includes("/statuses")) {
					return Promise.resolve({
						ok: false,
						status: 403,
						json: async () => ({}),
						text: async () => "Forbidden",
					});
				}
				return Promise.resolve({
					ok: true,
					status: 200,
					json: async () => ({ issues: [], total: 0 }),
					text: async () => "",
				});
			});

			await source.fetchNextIssue({
				...baseConfig,
				pick_from: 'It\'s "ready"\nnow',
			});

			const searchCall = capturedCalls.find((c) => c.url.includes("/search/jql"));
			const body = JSON.parse(searchCall!.body ?? "{}") as { jql: string };
			// Double quotes, single quotes, and newlines are all escaped/stripped
			expect(body.jql).toContain(`status = "It\\'s \\"ready\\" now"`);
		});

		it("falls back to status name when project statuses endpoint fails", async () => {
			const capturedCalls: { url: string; body?: string }[] = [];
			global.fetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
				capturedCalls.push({ url, body: opts?.body as string | undefined });
				if (url.includes("/project/") && url.includes("/statuses")) {
					return Promise.resolve({
						ok: false,
						status: 403,
						json: async () => ({}),
						text: async () => "Forbidden",
					});
				}
				return Promise.resolve({
					ok: true,
					status: 200,
					json: async () => ({ issues: [], total: 0 }),
					text: async () => "",
				});
			});

			await source.fetchNextIssue(baseConfig);

			const searchCall = capturedCalls.find((c) => c.url.includes("/search/jql"));
			const body = JSON.parse(searchCall!.body ?? "{}") as { jql: string };
			// Falls back to quoted status name
			expect(body.jql).toContain(`status = "Backlog"`);
		});

		it("skips blocked issues and returns unblocked one", async () => {
			const blockedIssue = makeIssue({
				key: "ENG-1",
				summary: "Blocked issue",
				issuelinks: [
					{
						type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
						inwardIssue: {
							key: "ENG-99",
							fields: {
								status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
							},
						},
					},
				],
			});
			const unblockedIssue = makeIssue({ key: "ENG-2", summary: "Unblocked issue" });
			global.fetch = mockFetchSequence([
				statusesResponse,
				ok({ issues: [blockedIssue, unblockedIssue], total: 2 }),
			]);

			const result = await source.fetchNextIssue(baseConfig);
			expect(result?.title).toBe("Unblocked issue");
		});

		it("returns null when all issues are blocked", async () => {
			const blockedIssue = makeIssue({
				key: "ENG-1",
				summary: "Blocked",
				issuelinks: [
					{
						type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
						inwardIssue: {
							key: "ENG-99",
							fields: {
								status: { name: "To Do", statusCategory: { key: "new" } },
							},
						},
					},
				],
			});
			global.fetch = mockFetchSequence([
				statusesResponse,
				ok({ issues: [blockedIssue], total: 1 }),
			]);

			const result = await source.fetchNextIssue(baseConfig);
			expect(result).toBeNull();
		});

		it("ignores blockers with done statusCategory", async () => {
			const issue = makeIssue({
				key: "ENG-1",
				summary: "Issue with done blocker",
				issuelinks: [
					{
						type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
						inwardIssue: {
							key: "ENG-99",
							fields: {
								status: { name: "Done", statusCategory: { key: "done" } },
							},
						},
					},
				],
			});
			global.fetch = mockFetchSequence([statusesResponse, ok({ issues: [issue], total: 1 })]);

			const result = await source.fetchNextIssue(baseConfig);
			expect(result?.title).toBe("Issue with done blocker");
		});

		it("respects priority among unblocked issues", async () => {
			const blockedP1 = makeIssue({
				key: "ENG-1",
				summary: "P1 blocked",
				priorityName: "Highest",
				issuelinks: [
					{
						type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
						inwardIssue: {
							key: "ENG-99",
							fields: {
								status: { name: "To Do", statusCategory: { key: "new" } },
							},
						},
					},
				],
			});
			const unblockedP3 = makeIssue({
				key: "ENG-2",
				summary: "P3 unblocked",
				priorityName: "Low",
			});
			const unblockedP2 = makeIssue({
				key: "ENG-3",
				summary: "P2 unblocked",
				priorityName: "High",
			});
			global.fetch = mockFetchSequence([
				statusesResponse,
				ok({ issues: [blockedP1, unblockedP3, unblockedP2], total: 3 }),
			]);

			const result = await source.fetchNextIssue(baseConfig);
			expect(result?.title).toBe("P2 unblocked");
		});

		it("uses Basic auth header", async () => {
			let capturedHeaders: Record<string, string> | undefined;
			global.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
				capturedHeaders = init?.headers as Record<string, string>;
				return Promise.resolve({
					ok: true,
					status: 200,
					json: async () => ({ issues: [], total: 0 }),
					text: async () => "",
				});
			});

			await source.fetchNextIssue(baseConfig);

			const expectedCreds = Buffer.from("user@example.com:test-token").toString("base64");
			expect(capturedHeaders?.Authorization).toBe(`Basic ${expectedCreds}`);
		});
	});

	// -------------------------------------------------------------------------
	// fetchIssueById
	// -------------------------------------------------------------------------

	describe("fetchIssueById", () => {
		it("fetches issue by key", async () => {
			global.fetch = mockFetchSequence([ok(makeIssue({ key: "ENG-42", summary: "My issue" }))]);

			const result = await source.fetchIssueById("ENG-42");
			expect(result?.id).toBe("ENG-42");
			expect(result?.title).toBe("My issue");
		});

		it("fetches issue by Jira URL", async () => {
			global.fetch = mockFetchSequence([ok(makeIssue({ key: "ENG-42", summary: "URL issue" }))]);

			const result = await source.fetchIssueById("https://example.atlassian.net/browse/ENG-42");
			expect(result?.id).toBe("ENG-42");
			expect(result?.title).toBe("URL issue");
		});

		it("returns null on API error", async () => {
			global.fetch = mockFetchSequence([err(404, "Not Found")]);
			const result = await source.fetchIssueById("ENG-999");
			expect(result).toBeNull();
		});
	});

	// -------------------------------------------------------------------------
	// updateStatus
	// -------------------------------------------------------------------------

	describe("updateStatus", () => {
		it("finds transition by name and posts it", async () => {
			let capturedUrl: string | undefined;
			let capturedBody: unknown;

			global.fetch = vi
				.fn()
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: async () => makeTransitions(["In Progress", "Done"]),
					text: async () => "",
				})
				.mockImplementationOnce((url: string, init?: RequestInit) => {
					capturedUrl = url;
					capturedBody = JSON.parse(init?.body as string);
					return Promise.resolve({
						ok: true,
						status: 204,
						json: async () => undefined,
						text: async () => "",
					});
				});

			await source.updateStatus("ENG-1", "In Progress");

			expect(capturedUrl).toContain("/issue/ENG-1/transitions");
			expect((capturedBody as { transition: { id: string } }).transition.id).toBe("1");
		});

		it("throws when transition not found", async () => {
			global.fetch = mockFetchSequence([ok(makeTransitions(["Backlog", "Done"]))]);

			await expect(source.updateStatus("ENG-1", "Nonexistent")).rejects.toThrow(
				'Jira transition "Nonexistent" not found',
			);
		});

		it("is case-insensitive when matching transition name", async () => {
			let capturedBody: unknown;

			global.fetch = vi
				.fn()
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: async () => makeTransitions(["IN PROGRESS", "Done"]),
					text: async () => "",
				})
				.mockImplementationOnce((_url: string, init?: RequestInit) => {
					capturedBody = JSON.parse(init?.body as string);
					return Promise.resolve({
						ok: true,
						status: 204,
						json: async () => undefined,
						text: async () => "",
					});
				});

			await source.updateStatus("ENG-1", "in progress");

			expect((capturedBody as { transition: { id: string } }).transition.id).toBe("1");
		});

		it("matches by target status name when transition name differs", async () => {
			let capturedBody: unknown;

			// Transition name is "Start Progress" but target status is "Em andamento"
			global.fetch = vi
				.fn()
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: async () =>
						makeTransitions(["Em andamento", "Concluído"], {
							transitionNames: ["Iniciar progresso", "Concluído"],
						}),
					text: async () => "",
				})
				.mockImplementationOnce((_url: string, init?: RequestInit) => {
					capturedBody = JSON.parse(init?.body as string);
					return Promise.resolve({
						ok: true,
						status: 204,
						json: async () => undefined,
						text: async () => "",
					});
				});

			// User config says "Em andamento" (status name), not "Iniciar progresso" (transition name)
			await source.updateStatus("ENG-1", "Em andamento");

			expect((capturedBody as { transition: { id: string } }).transition.id).toBe("1");
		});

		it("prefers target status name match over transition name match", async () => {
			let capturedBody: unknown;

			// Edge case: transition name "Done" targets status "Concluído",
			// and we search for "Concluído" — should match by to.name
			global.fetch = vi
				.fn()
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: async () => makeTransitions(["Concluído"], { transitionNames: ["Done"] }),
					text: async () => "",
				})
				.mockImplementationOnce((_url: string, init?: RequestInit) => {
					capturedBody = JSON.parse(init?.body as string);
					return Promise.resolve({
						ok: true,
						status: 204,
						json: async () => undefined,
						text: async () => "",
					});
				});

			await source.updateStatus("ENG-1", "Concluído");

			expect((capturedBody as { transition: { id: string } }).transition.id).toBe("1");
		});
	});

	// -------------------------------------------------------------------------
	// attachPullRequest
	// -------------------------------------------------------------------------

	describe("attachPullRequest", () => {
		it("posts a remote link with the PR URL", async () => {
			let capturedUrl: string | undefined;
			let capturedBody: unknown;

			global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
				capturedUrl = url;
				capturedBody = JSON.parse(init?.body as string);
				return Promise.resolve({
					ok: true,
					status: 200,
					json: async () => ({ id: 1 }),
					text: async () => "",
				});
			});

			await source.attachPullRequest("ENG-1", "https://github.com/org/repo/pull/42");

			expect(capturedUrl).toContain("/issue/ENG-1/remotelink");
			expect((capturedBody as { object: { url: string } }).object.url).toBe(
				"https://github.com/org/repo/pull/42",
			);
		});
	});

	// -------------------------------------------------------------------------
	// completeIssue
	// -------------------------------------------------------------------------

	describe("completeIssue", () => {
		it("transitions to done and removes label", async () => {
			const calls: string[] = [];

			global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
				const method = init?.method ?? "GET";
				calls.push(`${method} ${url}`);

				if (method === "GET" && url.includes("/transitions")) {
					return Promise.resolve({
						ok: true,
						status: 200,
						json: async () => makeTransitions(["In Progress", "Done"]),
						text: async () => "",
					});
				}

				if (method === "POST" && url.includes("/transitions")) {
					return Promise.resolve({
						ok: true,
						status: 204,
						json: async () => undefined,
						text: async () => "",
					});
				}

				if (method === "GET" && url.includes("/issue/ENG-1")) {
					return Promise.resolve({
						ok: true,
						status: 200,
						json: async () => makeIssue({ key: "ENG-1", labels: ["lisa", "wip"] }),
						text: async () => "",
					});
				}

				if (method === "PUT") {
					return Promise.resolve({
						ok: true,
						status: 204,
						json: async () => undefined,
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

			await source.completeIssue("ENG-1", "Done", "lisa");

			const postCalls = calls.filter((c) => c.startsWith("POST"));
			const putCalls = calls.filter((c) => c.startsWith("PUT"));
			expect(postCalls.length).toBeGreaterThanOrEqual(1);
			expect(putCalls.length).toBeGreaterThanOrEqual(1);
		});

		it("only transitions when no labelToRemove provided", async () => {
			const fetchMock = vi
				.fn()
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: async () => makeTransitions(["Done"]),
					text: async () => "",
				})
				.mockResolvedValueOnce({
					ok: true,
					status: 204,
					json: async () => undefined,
					text: async () => "",
				});

			global.fetch = fetchMock;

			await source.completeIssue("ENG-1", "Done");

			expect(fetchMock).toHaveBeenCalledTimes(2); // GET transitions + POST transition
		});
	});

	// -------------------------------------------------------------------------
	// listIssues
	// -------------------------------------------------------------------------

	describe("listIssues", () => {
		const statusesResponse = ok([
			{
				statuses: [
					{ id: "10001", name: "Backlog" },
					{ id: "10002", name: "In Progress" },
					{ id: "10003", name: "Done" },
				],
			},
		]);

		it("returns all issues with the configured label and status", async () => {
			const issues = [
				makeIssue({ key: "ENG-1", summary: "First issue" }),
				makeIssue({ key: "ENG-2", summary: "Second issue" }),
			];

			global.fetch = mockFetchSequence([statusesResponse, ok({ issues, total: 2 })]);

			const result = await source.listIssues(baseConfig);
			expect(result).toHaveLength(2);
			expect(result[0]).toMatchObject({ id: "ENG-1", title: "First issue" });
			expect(result[1]).toMatchObject({ id: "ENG-2", title: "Second issue" });
		});

		it("returns empty array when no issues found", async () => {
			global.fetch = mockFetchSequence([statusesResponse, ok({ issues: [], total: 0 })]);

			const result = await source.listIssues(baseConfig);
			expect(result).toEqual([]);
		});

		it("constructs correct issue URLs", async () => {
			global.fetch = mockFetchSequence([
				statusesResponse,
				ok({ issues: [makeIssue({ key: "ENG-42" })], total: 1 }),
			]);

			const result = await source.listIssues(baseConfig);
			expect(result[0]?.url).toBe("https://example.atlassian.net/browse/ENG-42");
		});
	});

	// -------------------------------------------------------------------------
	// wizard helpers
	// -------------------------------------------------------------------------

	describe("wizard helpers", () => {
		describe("listScopes", () => {
			it("returns projects as value/label pairs", async () => {
				global.fetch = mockFetchSequence([
					ok({
						values: [
							{ key: "ENG", name: "Engineering" },
							{ key: "OPS", name: "Operations" },
						],
						total: 2,
					}),
				]);

				const result = await source.listScopes();
				expect(result).toEqual([
					{ value: "ENG", label: "ENG — Engineering" },
					{ value: "OPS", label: "OPS — Operations" },
				]);
			});

			it("returns empty array when no projects", async () => {
				global.fetch = mockFetchSequence([ok({ values: [], total: 0 })]);

				const result = await source.listScopes();
				expect(result).toEqual([]);
			});

			it("calls the correct API endpoint", async () => {
				let capturedUrl: string | undefined;
				global.fetch = vi.fn().mockImplementation((url: string) => {
					capturedUrl = url;
					return Promise.resolve({
						ok: true,
						status: 200,
						json: async () => ({ values: [], total: 0 }),
						text: async () => "",
					});
				});

				await source.listScopes();
				expect(capturedUrl).toContain("/rest/api/3/project/search?maxResults=50");
			});
		});

		describe("listLabels", () => {
			it("returns labels as value/label pairs", async () => {
				global.fetch = mockFetchSequence([ok({ values: ["lisa", "ready", "wip"], total: 3 })]);

				const result = await source.listLabels();
				expect(result).toEqual([
					{ value: "lisa", label: "lisa" },
					{ value: "ready", label: "ready" },
					{ value: "wip", label: "wip" },
				]);
			});

			it("returns empty array when no labels", async () => {
				global.fetch = mockFetchSequence([ok({ values: [], total: 0 })]);

				const result = await source.listLabels();
				expect(result).toEqual([]);
			});

			it("calls the correct API endpoint", async () => {
				let capturedUrl: string | undefined;
				global.fetch = vi.fn().mockImplementation((url: string) => {
					capturedUrl = url;
					return Promise.resolve({
						ok: true,
						status: 200,
						json: async () => ({ values: [], total: 0 }),
						text: async () => "",
					});
				});

				await source.listLabels();
				expect(capturedUrl).toContain("/rest/api/3/label?maxResults=100");
			});
		});

		describe("listStatuses", () => {
			it("returns unique statuses across issue types", async () => {
				global.fetch = mockFetchSequence([
					ok([
						{
							statuses: [
								{ id: "1", name: "Backlog" },
								{ id: "2", name: "In Progress" },
								{ id: "3", name: "Done" },
							],
						},
						{
							statuses: [
								{ id: "1", name: "Backlog" },
								{ id: "4", name: "In Review" },
								{ id: "3", name: "Done" },
							],
						},
					]),
				]);

				const result = await source.listStatuses("ENG");
				expect(result).toEqual([
					{ value: "Backlog", label: "Backlog" },
					{ value: "In Progress", label: "In Progress" },
					{ value: "Done", label: "Done" },
					{ value: "In Review", label: "In Review" },
				]);
			});

			it("returns empty array when no issue types", async () => {
				global.fetch = mockFetchSequence([ok([])]);

				const result = await source.listStatuses("ENG");
				expect(result).toEqual([]);
			});

			it("calls the correct API endpoint", async () => {
				let capturedUrl: string | undefined;
				global.fetch = vi.fn().mockImplementation((url: string) => {
					capturedUrl = url;
					return Promise.resolve({
						ok: true,
						status: 200,
						json: async () => [],
						text: async () => "",
					});
				});

				await source.listStatuses("ENG");
				expect(capturedUrl).toContain("/rest/api/3/project/ENG/statuses");
			});
		});
	});

	// -------------------------------------------------------------------------
	// removeLabel
	// -------------------------------------------------------------------------

	describe("removeLabel", () => {
		it("removes the specified label", async () => {
			let capturedBody: unknown;

			global.fetch = vi
				.fn()
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: async () => makeIssue({ labels: ["lisa", "wip"] }),
					text: async () => "",
				})
				.mockImplementationOnce((_url: string, init?: RequestInit) => {
					capturedBody = JSON.parse(init?.body as string);
					return Promise.resolve({
						ok: true,
						status: 204,
						json: async () => undefined,
						text: async () => "",
					});
				});

			await source.removeLabel("ENG-1", "lisa");

			expect((capturedBody as { fields: { labels: string[] } }).fields.labels).toEqual(["wip"]);
		});

		it("skips the API call if label is not present", async () => {
			const fetchMock = vi.fn().mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => makeIssue({ labels: ["wip"] }),
				text: async () => "",
			});

			global.fetch = fetchMock;

			await source.removeLabel("ENG-1", "lisa");

			expect(fetchMock).toHaveBeenCalledTimes(1); // only GET, no PUT
		});

		it("is case-insensitive when matching label", async () => {
			let capturedBody: unknown;

			global.fetch = vi
				.fn()
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: async () => makeIssue({ labels: ["Lisa", "wip"] }),
					text: async () => "",
				})
				.mockImplementationOnce((_url: string, init?: RequestInit) => {
					capturedBody = JSON.parse(init?.body as string);
					return Promise.resolve({
						ok: true,
						status: 204,
						json: async () => undefined,
						text: async () => "",
					});
				});

			await source.removeLabel("ENG-1", "lisa");

			expect((capturedBody as { fields: { labels: string[] } }).fields.labels).toEqual(["wip"]);
		});

		it("parses Jira URL to extract issue key", async () => {
			let capturedUrl: string | undefined;

			global.fetch = vi.fn().mockImplementation((url: string) => {
				capturedUrl = url;
				return Promise.resolve({
					ok: true,
					status: 200,
					json: async () => makeIssue({ labels: [] }),
					text: async () => "",
				});
			});

			await source.removeLabel("https://example.atlassian.net/browse/ENG-42", "lisa");

			expect(capturedUrl).toContain("/issue/ENG-42");
		});
	});
});
