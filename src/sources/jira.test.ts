import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JiraSource } from "./jira.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeIssue(
	overrides: Partial<{
		id: string;
		key: string;
		priorityName: string | null;
		summary: string;
		description: unknown;
		labels: string[];
		statusName: string;
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
	};
}

function makeTransitions(names: string[] = ["In Progress", "Done", "Backlog"]): {
	transitions: { id: string; name: string }[];
} {
	return {
		transitions: names.map((name, i) => ({ id: String(i + 1), name })),
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
	team: "ENG",
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
		it("returns null when no issues found", async () => {
			global.fetch = mockFetchSequence([ok({ issues: [], total: 0 })]);
			const result = await source.fetchNextIssue(baseConfig);
			expect(result).toBeNull();
		});

		it("returns an issue with correct shape", async () => {
			global.fetch = mockFetchSequence([
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
			global.fetch = mockFetchSequence([ok({ issues, total: 3 })]);

			const result = await source.fetchNextIssue(baseConfig);
			expect(result?.title).toBe("Highest priority");
		});

		it("treats null priority as lowest priority", async () => {
			const issues = [
				makeIssue({ key: "ENG-1", summary: "No priority", priorityName: null }),
				makeIssue({ key: "ENG-2", summary: "Low priority", priorityName: "Low" }),
			];
			global.fetch = mockFetchSequence([ok({ issues, total: 2 })]);

			const result = await source.fetchNextIssue(baseConfig);
			expect(result?.title).toBe("Low priority");
		});

		it("extracts description from plain string", async () => {
			global.fetch = mockFetchSequence([
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
				ok({ issues: [makeIssue({ description: adfDoc })], total: 1 }),
			]);

			const result = await source.fetchNextIssue(baseConfig);
			expect(result?.description).toContain("First paragraph");
			expect(result?.description).toContain("Second paragraph");
		});

		it("returns empty description when description is null", async () => {
			global.fetch = mockFetchSequence([
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

		it("sends correct JQL query", async () => {
			let capturedUrl: string | undefined;
			global.fetch = vi.fn().mockImplementation((url: string) => {
				capturedUrl = url;
				return Promise.resolve({
					ok: true,
					status: 200,
					json: async () => ({ issues: [], total: 0 }),
					text: async () => "",
				});
			});

			await source.fetchNextIssue(baseConfig);

			expect(capturedUrl).toContain("jql=");
			expect(decodeURIComponent(capturedUrl ?? "")).toContain(`project = "ENG"`);
			expect(decodeURIComponent(capturedUrl ?? "")).toContain(`labels = "lisa"`);
			expect(decodeURIComponent(capturedUrl ?? "")).toContain(`status = "Backlog"`);
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
