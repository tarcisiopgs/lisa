import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubIssuesSource, parseDependencies, parseGitHubIssueNumber } from "./github-issues.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeIssue(
	overrides: Partial<{
		number: number;
		title: string;
		body: string | null;
		html_url: string;
		labels: { name: string }[];
		created_at: string;
	}> = {},
) {
	return {
		number: 42,
		title: "Fix bug",
		body: "Some description",
		html_url: "https://github.com/org/repo/issues/42",
		labels: [{ name: "ready" }],
		created_at: "2024-01-01T00:00:00Z",
		...overrides,
	};
}

function mockFetch(response: unknown, ok = true, status = 200) {
	return vi.fn().mockResolvedValue({
		ok,
		status,
		json: async () => response,
		text: async () => JSON.stringify(response),
	});
}

// ---------------------------------------------------------------------------
// parseDependencies
// ---------------------------------------------------------------------------

describe("parseDependencies", () => {
	it("returns empty array for null body", () => {
		expect(parseDependencies(null)).toEqual([]);
	});

	it("returns empty array for body without dependencies", () => {
		expect(parseDependencies("Just a regular issue description")).toEqual([]);
	});

	it("parses 'depends on #N'", () => {
		expect(parseDependencies("This depends on #42")).toEqual([42]);
	});

	it("parses 'blocked by #N'", () => {
		expect(parseDependencies("This is blocked by #10")).toEqual([10]);
	});

	it("parses multiple dependencies", () => {
		const body = "depends on #1\nblocked by #2\ndepends on #3";
		expect(parseDependencies(body)).toEqual([1, 2, 3]);
	});

	it("is case-insensitive", () => {
		expect(parseDependencies("Depends On #5")).toEqual([5]);
		expect(parseDependencies("BLOCKED BY #7")).toEqual([7]);
	});

	it("deduplicates issue numbers", () => {
		const body = "depends on #1\nblocked by #1";
		expect(parseDependencies(body)).toEqual([1]);
	});
});

// ---------------------------------------------------------------------------
// parseGitHubIssueNumber
// ---------------------------------------------------------------------------

describe("parseGitHubIssueNumber", () => {
	it("parses a full GitHub URL", () => {
		const ref = parseGitHubIssueNumber("https://github.com/my-org/my-repo/issues/99");
		expect(ref).toEqual({ owner: "my-org", repo: "my-repo", number: "99" });
	});

	it("parses composite owner/repo#number format", () => {
		const ref = parseGitHubIssueNumber("my-org/my-repo#55");
		expect(ref).toEqual({ owner: "my-org", repo: "my-repo", number: "55" });
	});

	it("returns empty owner/repo for plain number", () => {
		const ref = parseGitHubIssueNumber("42");
		expect(ref).toEqual({ owner: "", repo: "", number: "42" });
	});
});

// ---------------------------------------------------------------------------
// GitHubIssuesSource
// ---------------------------------------------------------------------------

describe("GitHubIssuesSource", () => {
	let source: GitHubIssuesSource;

	beforeEach(() => {
		source = new GitHubIssuesSource();
		process.env.GITHUB_TOKEN = "test-token";
	});

	afterEach(() => {
		delete process.env.GITHUB_TOKEN;
		vi.restoreAllMocks();
	});

	const baseConfig = {
		team: "my-org/my-repo",
		project: "",
		label: "ready",
		pick_from: "",
		in_progress: "in-progress",
		done: "done",
	};

	// -------------------------------------------------------------------------
	// name
	// -------------------------------------------------------------------------

	it("has correct name", () => {
		expect(source.name).toBe("github-issues");
	});

	// -------------------------------------------------------------------------
	// fetchNextIssue
	// -------------------------------------------------------------------------

	describe("fetchNextIssue", () => {
		it("returns null when no issues found", async () => {
			global.fetch = mockFetch([]);
			const result = await source.fetchNextIssue(baseConfig);
			expect(result).toBeNull();
		});

		it("returns the first issue from sorted list", async () => {
			const issues = [makeIssue({ number: 1, title: "Issue 1" })];
			global.fetch = mockFetch(issues);

			const result = await source.fetchNextIssue(baseConfig);
			expect(result).not.toBeNull();
			expect(result?.title).toBe("Issue 1");
			expect(result?.id).toBe("my-org/my-repo#1");
		});

		it("returns correct issue shape", async () => {
			const issues = [
				makeIssue({
					number: 7,
					title: "My issue",
					body: "Description here",
					html_url: "https://github.com/my-org/my-repo/issues/7",
				}),
			];
			global.fetch = mockFetch(issues);

			const result = await source.fetchNextIssue(baseConfig);
			expect(result?.id).toBe("my-org/my-repo#7");
			expect(result?.title).toBe("My issue");
			expect(result?.description).toBe("Description here");
			expect(result?.url).toBe("https://github.com/my-org/my-repo/issues/7");
		});

		it("returns empty string when body is null", async () => {
			global.fetch = mockFetch([makeIssue({ body: null })]);
			const result = await source.fetchNextIssue(baseConfig);
			expect(result?.description).toBe("");
		});

		it("sorts by priority labels p1 > p2 > p3", async () => {
			const issues = [
				makeIssue({ number: 1, title: "P3 issue", labels: [{ name: "ready" }, { name: "p3" }] }),
				makeIssue({ number: 2, title: "P1 issue", labels: [{ name: "ready" }, { name: "p1" }] }),
				makeIssue({ number: 3, title: "P2 issue", labels: [{ name: "ready" }, { name: "p2" }] }),
			];
			global.fetch = mockFetch(issues);

			const result = await source.fetchNextIssue(baseConfig);
			expect(result?.title).toBe("P1 issue");
		});

		it("sorts by created_at when priority is equal", async () => {
			const issues = [
				makeIssue({ number: 2, title: "Newer issue", created_at: "2024-02-01T00:00:00Z" }),
				makeIssue({ number: 1, title: "Older issue", created_at: "2024-01-01T00:00:00Z" }),
			];
			global.fetch = mockFetch(issues);

			const result = await source.fetchNextIssue(baseConfig);
			expect(result?.title).toBe("Older issue");
		});

		it("passes multiple labels as comma-separated in URL", async () => {
			let capturedUrl: string | undefined;
			global.fetch = vi.fn().mockImplementation((url: string) => {
				capturedUrl = url;
				return Promise.resolve({
					ok: true,
					status: 200,
					json: async () => [],
					text: async () => "[]",
				});
			});

			await source.fetchNextIssue({ ...baseConfig, label: ["ready", "api"] });

			expect(capturedUrl).toContain("labels=ready,api");
		});

		it("includes priority label sort URL params", async () => {
			let capturedUrl: string | undefined;
			global.fetch = vi.fn().mockImplementation((url: string) => {
				capturedUrl = url;
				return Promise.resolve({
					ok: true,
					status: 200,
					json: async () => [],
					text: async () => "[]",
				});
			});

			await source.fetchNextIssue(baseConfig);

			expect(capturedUrl).toContain("/repos/my-org/my-repo/issues");
			expect(capturedUrl).toContain("labels=ready");
			expect(capturedUrl).toContain("state=open");
		});

		it("throws if GITHUB_TOKEN is not set", async () => {
			delete process.env.GITHUB_TOKEN;
			await expect(source.fetchNextIssue(baseConfig)).rejects.toThrow("GITHUB_TOKEN must be set");
		});

		it("throws on API error", async () => {
			global.fetch = mockFetch("Not Found", false, 404);
			await expect(source.fetchNextIssue(baseConfig)).rejects.toThrow("GitHub API error (404)");
		});

		it("uses Bearer token auth header", async () => {
			let capturedHeaders: Record<string, string> | undefined;
			global.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
				capturedHeaders = init?.headers as Record<string, string>;
				return Promise.resolve({
					ok: true,
					status: 200,
					json: async () => [],
					text: async () => "[]",
				});
			});

			await source.fetchNextIssue(baseConfig);

			expect(capturedHeaders?.Authorization).toBe("Bearer test-token");
		});

		it("throws on invalid owner/repo format", async () => {
			const badConfig = { ...baseConfig, team: "invalid-format" };
			await expect(source.fetchNextIssue(badConfig)).rejects.toThrow(
				'Invalid owner/repo format: "invalid-format"',
			);
		});

		it("skips issues blocked by open dependencies", async () => {
			const blockedIssue = makeIssue({
				number: 1,
				title: "Blocked issue",
				body: "depends on #99",
			});
			const unblockedIssue = makeIssue({
				number: 2,
				title: "Unblocked issue",
				body: "No dependencies here",
			});

			global.fetch = vi.fn().mockImplementation((url: string) => {
				let data: unknown;
				if (url.includes("/issues?")) data = [blockedIssue, unblockedIssue];
				else if (url.includes("/issues/99")) data = { number: 99, state: "open", title: "Dep" };
				else data = [];
				return Promise.resolve({
					ok: true,
					status: 200,
					json: async () => data,
					text: async () => JSON.stringify(data),
				});
			});

			const result = await source.fetchNextIssue(baseConfig);
			expect(result?.title).toBe("Unblocked issue");
		});

		it("returns null when all issues are blocked", async () => {
			const blockedIssue = makeIssue({
				number: 1,
				title: "Blocked",
				body: "blocked by #99",
			});

			global.fetch = vi.fn().mockImplementation((url: string) => {
				let data: unknown;
				if (url.includes("/issues?")) data = [blockedIssue];
				else if (url.includes("/issues/99")) data = { number: 99, state: "open", title: "Dep" };
				else data = [];
				return Promise.resolve({
					ok: true,
					status: 200,
					json: async () => data,
					text: async () => JSON.stringify(data),
				});
			});

			const result = await source.fetchNextIssue(baseConfig);
			expect(result).toBeNull();
		});

		it("does not skip issues when dependency is closed", async () => {
			const issue = makeIssue({
				number: 1,
				title: "Issue with closed dep",
				body: "depends on #99",
			});

			global.fetch = vi.fn().mockImplementation((url: string) => {
				let data: unknown;
				if (url.includes("/issues?")) data = [issue];
				else if (url.includes("/issues/99"))
					data = { number: 99, state: "closed", title: "Done dep" };
				else data = [];
				return Promise.resolve({
					ok: true,
					status: 200,
					json: async () => data,
					text: async () => JSON.stringify(data),
				});
			});

			const result = await source.fetchNextIssue(baseConfig);
			expect(result?.title).toBe("Issue with closed dep");
		});

		it("respects priority among unblocked issues", async () => {
			const blockedP1 = makeIssue({
				number: 1,
				title: "P1 blocked",
				body: "blocked by #99",
				labels: [{ name: "ready" }, { name: "p1" }],
			});
			const unblockedP3 = makeIssue({
				number: 2,
				title: "P3 unblocked",
				labels: [{ name: "ready" }, { name: "p3" }],
			});
			const unblockedP2 = makeIssue({
				number: 3,
				title: "P2 unblocked",
				labels: [{ name: "ready" }, { name: "p2" }],
			});

			global.fetch = vi.fn().mockImplementation((url: string) => {
				let data: unknown;
				if (url.includes("/issues?")) data = [blockedP1, unblockedP3, unblockedP2];
				else if (url.includes("/issues/99")) data = { number: 99, state: "open", title: "Dep" };
				else data = [];
				return Promise.resolve({
					ok: true,
					status: 200,
					json: async () => data,
					text: async () => JSON.stringify(data),
				});
			});

			const result = await source.fetchNextIssue(baseConfig);
			expect(result?.title).toBe("P2 unblocked");
		});
	});

	// -------------------------------------------------------------------------
	// fetchIssueById
	// -------------------------------------------------------------------------

	describe("fetchIssueById", () => {
		it("fetches by GitHub URL", async () => {
			global.fetch = mockFetch(makeIssue({ number: 42, title: "URL issue" }));
			const result = await source.fetchIssueById("https://github.com/org/repo/issues/42");
			expect(result?.title).toBe("URL issue");
			expect(result?.id).toBe("org/repo#42");
		});

		it("fetches by composite id format", async () => {
			global.fetch = mockFetch(makeIssue({ number: 10, title: "Composite issue" }));
			const result = await source.fetchIssueById("org/repo#10");
			expect(result?.title).toBe("Composite issue");
		});

		it("returns null on API error", async () => {
			global.fetch = mockFetch("Not Found", false, 404);
			const result = await source.fetchIssueById("org/repo#999");
			expect(result).toBeNull();
		});
	});

	// -------------------------------------------------------------------------
	// updateStatus
	// -------------------------------------------------------------------------

	describe("updateStatus", () => {
		it("adds in_progress label via POST", async () => {
			let capturedUrl: string | undefined;
			let capturedBody: unknown;

			global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
				capturedUrl = url;
				capturedBody = JSON.parse(init?.body as string);
				return Promise.resolve({
					ok: true,
					status: 200,
					json: async () => [{ name: "in-progress" }],
					text: async () => "",
				});
			});

			await source.updateStatus("my-org/my-repo#42", "in-progress");

			expect(capturedUrl).toContain("/repos/my-org/my-repo/issues/42/labels");
			expect((capturedBody as { labels: string[] }).labels).toContain("in-progress");
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
					json: async () => ({ id: 1 }),
					text: async () => "",
				});
			});

			await source.attachPullRequest("my-org/my-repo#42", "https://github.com/org/repo/pull/7");

			expect(capturedUrl).toContain("/repos/my-org/my-repo/issues/42/comments");
			expect((capturedBody as { body: string }).body).toBe(
				"Pull request: https://github.com/org/repo/pull/7",
			);
		});
	});

	// -------------------------------------------------------------------------
	// completeIssue
	// -------------------------------------------------------------------------

	describe("completeIssue", () => {
		it("closes the issue via PATCH", async () => {
			let capturedBody: unknown;

			global.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
				const method = init?.method ?? "GET";
				if (method === "PATCH") {
					capturedBody = JSON.parse(init?.body as string);
				}
				return Promise.resolve({
					ok: true,
					status: 200,
					json: async () => ({}),
					text: async () => "",
				});
			});

			await source.completeIssue("my-org/my-repo#42", "done");

			expect((capturedBody as { state: string }).state).toBe("closed");
		});

		it("removes the pickup label after closing", async () => {
			const calls: string[] = [];

			global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
				const method = init?.method ?? "GET";
				calls.push(`${method} ${url}`);
				return Promise.resolve({
					ok: true,
					status: 200,
					json: async () => ({}),
					text: async () => "",
				});
			});

			await source.completeIssue("my-org/my-repo#42", "done", "ready");

			const patchCalls = calls.filter((c) => c.startsWith("PATCH"));
			const deleteCalls = calls.filter((c) => c.startsWith("DELETE"));
			expect(patchCalls.length).toBe(1);
			expect(deleteCalls.length).toBe(1);
			expect(deleteCalls[0]).toContain("/labels/ready");
		});

		it("does not call DELETE when labelToRemove is not provided", async () => {
			const fetchMock = vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				json: async () => ({}),
				text: async () => "",
			});
			global.fetch = fetchMock;

			await source.completeIssue("my-org/my-repo#42", "done");

			const calls = fetchMock.mock.calls.map((args: unknown[]) => {
				const [url, init] = args as [string, RequestInit | undefined];
				return `${init?.method ?? "GET"} ${url}`;
			});
			expect(calls.filter((c) => c.startsWith("DELETE"))).toHaveLength(0);
		});
	});

	// -------------------------------------------------------------------------
	// listIssues
	// -------------------------------------------------------------------------

	describe("listIssues", () => {
		beforeEach(() => {
			process.env.GITHUB_TOKEN = "test-token";
		});

		afterEach(() => {
			vi.restoreAllMocks();
			delete process.env.GITHUB_TOKEN;
		});

		it("returns all open issues with the configured label", async () => {
			const issues = [
				makeIssue({ number: 1, title: "Issue one" }),
				makeIssue({ number: 2, title: "Issue two" }),
			];
			vi.stubGlobal("fetch", mockFetch(issues));

			const result = await source.listIssues({
				team: "my-org/my-repo",
				project: "",
				label: "ready",
				pick_from: "Backlog",
				in_progress: "In Progress",
				done: "Done",
			});

			expect(result).toHaveLength(2);
			expect(result[0]).toMatchObject({ title: "Issue one" });
			expect(result[1]).toMatchObject({ title: "Issue two" });
		});

		it("returns empty array when no issues", async () => {
			vi.stubGlobal("fetch", mockFetch([]));

			const result = await source.listIssues({
				team: "my-org/my-repo",
				project: "",
				label: "ready",
				pick_from: "Backlog",
				in_progress: "In Progress",
				done: "Done",
			});

			expect(result).toEqual([]);
		});
	});

	// -------------------------------------------------------------------------
	// removeLabel
	// -------------------------------------------------------------------------

	describe("removeLabel", () => {
		it("calls DELETE on the label endpoint", async () => {
			let capturedUrl: string | undefined;

			global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
				capturedUrl = url;
				const method = init?.method ?? "GET";
				return Promise.resolve({
					ok: true,
					status: method === "DELETE" ? 200 : 200,
					json: async () => ({}),
					text: async () => "",
				});
			});

			await source.removeLabel("my-org/my-repo#42", "ready");

			expect(capturedUrl).toContain("/repos/my-org/my-repo/issues/42/labels/ready");
		});

		it("URL-encodes label names with spaces", async () => {
			let capturedUrl: string | undefined;

			global.fetch = vi.fn().mockImplementation((url: string) => {
				capturedUrl = url;
				return Promise.resolve({
					ok: true,
					status: 200,
					json: async () => ({}),
					text: async () => "",
				});
			});

			await source.removeLabel("my-org/my-repo#42", "in progress");

			expect(capturedUrl).toContain("in%20progress");
		});

		it("silently ignores errors (label not on issue)", async () => {
			global.fetch = mockFetch("Not Found", false, 404);

			// Should not throw
			await expect(source.removeLabel("my-org/my-repo#42", "nonexistent")).resolves.toBeUndefined();
		});
	});
});
