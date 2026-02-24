import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitLabIssuesSource, parseGitLabIssueRef, parseGitLabProject } from "./gitlab-issues.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeIssue(
	overrides: Partial<{
		id: number;
		iid: number;
		title: string;
		description: string | null;
		web_url: string;
		labels: string[];
		created_at: string;
	}> = {},
) {
	return {
		id: 1,
		iid: 42,
		title: "Fix bug",
		description: "Some description",
		web_url: "https://gitlab.com/org/repo/-/issues/42",
		labels: ["ready"],
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
// parseGitLabProject
// ---------------------------------------------------------------------------

describe("parseGitLabProject", () => {
	it("returns numeric IDs as-is", () => {
		expect(parseGitLabProject("12345")).toBe("12345");
	});

	it("URL-encodes namespace/project paths", () => {
		expect(parseGitLabProject("my-org/my-repo")).toBe("my-org%2Fmy-repo");
	});

	it("URL-encodes nested paths", () => {
		expect(parseGitLabProject("group/sub/repo")).toBe("group%2Fsub%2Frepo");
	});
});

// ---------------------------------------------------------------------------
// parseGitLabIssueRef
// ---------------------------------------------------------------------------

describe("parseGitLabIssueRef", () => {
	it("parses a full GitLab URL", () => {
		const ref = parseGitLabIssueRef("https://gitlab.com/my-org/my-repo/-/issues/99");
		expect(ref).toEqual({ project: "my-org/my-repo", iid: "99" });
	});

	it("parses a self-hosted GitLab URL", () => {
		const ref = parseGitLabIssueRef("https://gitlab.example.com/team/project/-/issues/7");
		expect(ref).toEqual({ project: "team/project", iid: "7" });
	});

	it("parses composite namespace/project#iid format", () => {
		const ref = parseGitLabIssueRef("my-org/my-repo#55");
		expect(ref).toEqual({ project: "my-org/my-repo", iid: "55" });
	});

	it("parses numeric project#iid format", () => {
		const ref = parseGitLabIssueRef("12345#10");
		expect(ref).toEqual({ project: "12345", iid: "10" });
	});

	it("returns plain IID with empty project for bare numbers", () => {
		const ref = parseGitLabIssueRef("42");
		expect(ref).toEqual({ project: "", iid: "42" });
	});
});

// ---------------------------------------------------------------------------
// GitLabIssuesSource
// ---------------------------------------------------------------------------

describe("GitLabIssuesSource", () => {
	let source: GitLabIssuesSource;

	beforeEach(() => {
		source = new GitLabIssuesSource();
		process.env.GITLAB_TOKEN = "test-token";
		process.env.GITLAB_BASE_URL = "https://gitlab.example.com";
	});

	afterEach(() => {
		delete process.env.GITLAB_TOKEN;
		delete process.env.GITLAB_BASE_URL;
		vi.restoreAllMocks();
	});

	// -------------------------------------------------------------------------
	// name
	// -------------------------------------------------------------------------

	it("has correct name", () => {
		expect(source.name).toBe("gitlab-issues");
	});

	// -------------------------------------------------------------------------
	// fetchNextIssue
	// -------------------------------------------------------------------------

	describe("fetchNextIssue", () => {
		const config = {
			team: "my-org/my-repo",
			project: "",
			label: "ready",
			pick_from: "",
			in_progress: "in-progress",
			done: "done",
		};

		it("returns null when no issues found", async () => {
			global.fetch = mockFetch([]);
			const result = await source.fetchNextIssue(config);
			expect(result).toBeNull();
		});

		it("returns the first issue from sorted list", async () => {
			const issues = [makeIssue({ iid: 1, title: "Issue 1", created_at: "2024-01-01T00:00:00Z" })];
			global.fetch = mockFetch(issues);

			const result = await source.fetchNextIssue(config);
			expect(result).not.toBeNull();
			expect(result?.title).toBe("Issue 1");
			expect(result?.id).toBe("my-org/my-repo#1");
		});

		it("sorts by priority labels p1 > p2 > p3", async () => {
			const issues = [
				makeIssue({ iid: 1, title: "P3 issue", labels: ["ready", "p3"] }),
				makeIssue({ iid: 2, title: "P1 issue", labels: ["ready", "p1"] }),
				makeIssue({ iid: 3, title: "P2 issue", labels: ["ready", "p2"] }),
			];
			global.fetch = mockFetch(issues);

			const result = await source.fetchNextIssue(config);
			expect(result?.title).toBe("P1 issue");
		});

		it("sorts by created_at when priority is equal", async () => {
			const issues = [
				makeIssue({ iid: 2, title: "Newer issue", created_at: "2024-02-01T00:00:00Z" }),
				makeIssue({ iid: 1, title: "Older issue", created_at: "2024-01-01T00:00:00Z" }),
			];
			global.fetch = mockFetch(issues);

			const result = await source.fetchNextIssue(config);
			expect(result?.title).toBe("Older issue");
		});

		it("uses numeric project ID as-is", async () => {
			const numericConfig = { ...config, team: "12345" };
			global.fetch = mockFetch([makeIssue({ iid: 7 })]);

			const result = await source.fetchNextIssue(numericConfig);
			expect(result?.id).toBe("12345#7");
		});

		it("throws if GITLAB_TOKEN is not set", async () => {
			delete process.env.GITLAB_TOKEN;
			await expect(source.fetchNextIssue(config)).rejects.toThrow("GITLAB_TOKEN must be set");
		});

		it("throws on API error", async () => {
			global.fetch = mockFetch("Not Found", false, 404);
			await expect(source.fetchNextIssue(config)).rejects.toThrow("GitLab API error (404)");
		});
	});

	// -------------------------------------------------------------------------
	// fetchIssueById
	// -------------------------------------------------------------------------

	describe("fetchIssueById", () => {
		it("fetches by GitLab URL", async () => {
			global.fetch = mockFetch(makeIssue({ iid: 42, title: "URL issue" }));
			const result = await source.fetchIssueById(
				"https://gitlab.example.com/org/project/-/issues/42",
			);
			expect(result?.title).toBe("URL issue");
			expect(result?.id).toBe("org/project#42");
		});

		it("fetches by composite id format", async () => {
			global.fetch = mockFetch(makeIssue({ iid: 10, title: "Composite issue" }));
			const result = await source.fetchIssueById("org/project#10");
			expect(result?.title).toBe("Composite issue");
		});

		it("returns null on API error", async () => {
			global.fetch = mockFetch("Not Found", false, 404);
			const result = await source.fetchIssueById("org/project#999");
			expect(result).toBeNull();
		});
	});

	// -------------------------------------------------------------------------
	// updateStatus
	// -------------------------------------------------------------------------

	describe("updateStatus", () => {
		it("adds label to the issue", async () => {
			const existingIssue = makeIssue({ labels: ["ready"] });
			let capturedBody: unknown;

			global.fetch = vi
				.fn()
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: async () => existingIssue,
					text: async () => "",
				})
				.mockImplementationOnce((_url: string, init?: RequestInit) => {
					capturedBody = JSON.parse(init?.body as string);
					return Promise.resolve({
						ok: true,
						status: 200,
						json: async () => ({}),
						text: async () => "",
					});
				});

			await source.updateStatus("org/project#42", "in-progress");
			expect(capturedBody).toMatchObject({ labels: expect.stringContaining("in-progress") });
		});

		it("does not duplicate existing labels", async () => {
			const existingIssue = makeIssue({ labels: ["ready", "in-progress"] });
			let capturedBody: unknown;

			global.fetch = vi
				.fn()
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: async () => existingIssue,
					text: async () => "",
				})
				.mockImplementationOnce((_url: string, init?: RequestInit) => {
					capturedBody = JSON.parse(init?.body as string);
					return Promise.resolve({
						ok: true,
						status: 200,
						json: async () => ({}),
						text: async () => "",
					});
				});

			await source.updateStatus("org/project#42", "in-progress");
			const labels = (capturedBody as { labels: string }).labels.split(",");
			expect(labels.filter((l: string) => l === "in-progress")).toHaveLength(1);
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
					json: async () => ({}),
					text: async () => "",
				});
			});

			await source.attachPullRequest("org/project#42", "https://github.com/org/repo/pull/7");
			expect(capturedUrl).toContain("/notes");
			expect(capturedBody).toMatchObject({
				body: "Pull request: https://github.com/org/repo/pull/7",
			});
		});
	});

	// -------------------------------------------------------------------------
	// completeIssue
	// -------------------------------------------------------------------------

	describe("completeIssue", () => {
		it("closes the issue and removes the pickup label", async () => {
			const existingIssue = makeIssue({ labels: ["ready", "in-progress"] });
			let capturedBody: unknown;

			global.fetch = vi
				.fn()
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: async () => existingIssue,
					text: async () => "",
				})
				.mockImplementationOnce((_url: string, init?: RequestInit) => {
					capturedBody = JSON.parse(init?.body as string);
					return Promise.resolve({
						ok: true,
						status: 200,
						json: async () => ({}),
						text: async () => "",
					});
				});

			await source.completeIssue("org/project#42", "done", "ready");
			expect(capturedBody).toMatchObject({ state_event: "close" });
			const labels = (capturedBody as { labels: string }).labels.split(",");
			expect(labels).not.toContain("ready");
			expect(labels).toContain("in-progress");
		});

		it("closes the issue without removing a label when labelToRemove is omitted", async () => {
			const existingIssue = makeIssue({ labels: ["in-progress"] });
			let capturedBody: unknown;

			global.fetch = vi
				.fn()
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: async () => existingIssue,
					text: async () => "",
				})
				.mockImplementationOnce((_url: string, init?: RequestInit) => {
					capturedBody = JSON.parse(init?.body as string);
					return Promise.resolve({
						ok: true,
						status: 200,
						json: async () => ({}),
						text: async () => "",
					});
				});

			await source.completeIssue("org/project#42", "done");
			expect(capturedBody).toMatchObject({ state_event: "close", labels: "in-progress" });
		});
	});

	// -------------------------------------------------------------------------
	// listIssues
	// -------------------------------------------------------------------------

	describe("listIssues", () => {
		beforeEach(() => {
			process.env.GITLAB_TOKEN = "test-token";
		});

		afterEach(() => {
			vi.restoreAllMocks();
			delete process.env.GITLAB_TOKEN;
		});

		it("returns all open issues with the configured label", async () => {
			const issues = [
				makeIssue({ iid: 10, title: "First" }),
				makeIssue({ iid: 11, title: "Second" }),
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
			expect(result[0]).toMatchObject({ title: "First" });
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
		it("removes the specified label", async () => {
			const existingIssue = makeIssue({ labels: ["ready", "in-progress"] });
			let capturedBody: unknown;

			global.fetch = vi
				.fn()
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: async () => existingIssue,
					text: async () => "",
				})
				.mockImplementationOnce((_url: string, init?: RequestInit) => {
					capturedBody = JSON.parse(init?.body as string);
					return Promise.resolve({
						ok: true,
						status: 200,
						json: async () => ({}),
						text: async () => "",
					});
				});

			await source.removeLabel("org/project#42", "ready");
			const labels = (capturedBody as { labels: string }).labels.split(",");
			expect(labels).not.toContain("ready");
			expect(labels).toContain("in-progress");
		});

		it("skips the API call if label is not present", async () => {
			const existingIssue = makeIssue({ labels: ["in-progress"] });
			const fetchMock = vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				json: async () => existingIssue,
				text: async () => "",
			});
			global.fetch = fetchMock;

			await source.removeLabel("org/project#42", "ready");
			// Only one fetch call (GET), no PUT
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		it("is case-insensitive when matching label to remove", async () => {
			const existingIssue = makeIssue({ labels: ["Ready", "in-progress"] });
			let capturedBody: unknown;

			global.fetch = vi
				.fn()
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: async () => existingIssue,
					text: async () => "",
				})
				.mockImplementationOnce((_url: string, init?: RequestInit) => {
					capturedBody = JSON.parse(init?.body as string);
					return Promise.resolve({
						ok: true,
						status: 200,
						json: async () => ({}),
						text: async () => "",
					});
				});

			await source.removeLabel("org/project#42", "ready");
			const labels = (capturedBody as { labels: string }).labels.split(",");
			expect(labels).not.toContain("Ready");
		});
	});
});
