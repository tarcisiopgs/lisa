import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	appendMrAttribution,
	createMergeRequest,
	getGitLabRepoInfo,
	isGitLabUrl,
} from "./gitlab.js";

// Mock execa
const mockExeca = vi.fn();
vi.mock("execa", () => ({
	execa: (...args: unknown[]) => mockExeca(...args),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("getGitLabRepoInfo", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("parses SSH remote URL", async () => {
		mockExeca.mockImplementation((_cmd: string, args: string[]) => {
			if (args[0] === "remote" && args[1] === "get-url") {
				return Promise.resolve({ stdout: "git@gitlab.com:myorg/myrepo.git" });
			}
			if (args[0] === "branch" && args[1] === "--show-current") {
				return Promise.resolve({ stdout: "feat/my-branch" });
			}
			if (args[0] === "symbolic-ref") {
				return Promise.resolve({ stdout: "origin/main" });
			}
			return Promise.resolve({ stdout: "" });
		});

		const info = await getGitLabRepoInfo("/some/cwd");

		expect(info.host).toBe("gitlab.com");
		expect(info.namespace).toBe("myorg");
		expect(info.project).toBe("myrepo");
		expect(info.branch).toBe("feat/my-branch");
		expect(info.defaultBranch).toBe("main");
	});

	it("parses HTTPS remote URL", async () => {
		mockExeca.mockImplementation((_cmd: string, args: string[]) => {
			if (args[0] === "remote" && args[1] === "get-url") {
				return Promise.resolve({
					stdout: "https://gitlab.com/myorg/myrepo.git",
				});
			}
			if (args[0] === "branch" && args[1] === "--show-current") {
				return Promise.resolve({ stdout: "main" });
			}
			if (args[0] === "symbolic-ref") {
				return Promise.resolve({ stdout: "origin/main" });
			}
			return Promise.resolve({ stdout: "" });
		});

		const info = await getGitLabRepoInfo("/some/cwd");

		expect(info.host).toBe("gitlab.com");
		expect(info.namespace).toBe("myorg");
		expect(info.project).toBe("myrepo");
	});

	it("supports self-hosted GitLab SSH URL", async () => {
		mockExeca.mockImplementation((_cmd: string, args: string[]) => {
			if (args[0] === "remote" && args[1] === "get-url") {
				return Promise.resolve({
					stdout: "git@gitlab.example.com:myorg/myrepo.git",
				});
			}
			if (args[0] === "branch" && args[1] === "--show-current") {
				return Promise.resolve({ stdout: "main" });
			}
			if (args[0] === "symbolic-ref") {
				return Promise.resolve({ stdout: "origin/main" });
			}
			return Promise.resolve({ stdout: "" });
		});

		const info = await getGitLabRepoInfo("/some/cwd");

		expect(info.host).toBe("gitlab.example.com");
		expect(info.namespace).toBe("myorg");
		expect(info.project).toBe("myrepo");
	});

	it("throws on unrecognized remote URL", async () => {
		mockExeca.mockImplementation((_cmd: string, args: string[]) => {
			if (args[0] === "remote" && args[1] === "get-url") {
				return Promise.resolve({ stdout: "https://example.com/not-a-git-repo" });
			}
			return Promise.resolve({ stdout: "" });
		});

		await expect(getGitLabRepoInfo("/some/cwd")).rejects.toThrow(
			"Cannot parse GitLab namespace/project from remote URL",
		);
	});
});

describe("createMergeRequest", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env.GITLAB_TOKEN = "test-token";
	});

	afterEach(() => {
		delete process.env.GITLAB_TOKEN;
	});

	it("creates a merge request via GitLab API", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				iid: 42,
				web_url: "https://gitlab.com/myorg/myrepo/-/merge_requests/42",
			}),
		});

		const result = await createMergeRequest({
			namespace: "myorg",
			project: "myrepo",
			sourceBranch: "feat/new-feature",
			targetBranch: "main",
			title: "feat: add new feature",
			description: "Adds a new feature",
		});

		expect(result.iid).toBe(42);
		expect(result.web_url).toBe("https://gitlab.com/myorg/myrepo/-/merge_requests/42");

		const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
		expect(url).toContain("/api/v4/projects/");
		expect(url).toContain("merge_requests");
		expect(options.method).toBe("POST");
		expect(options.headers).toMatchObject({ "PRIVATE-TOKEN": "test-token" });
	});

	it("throws when GITLAB_TOKEN is not set", async () => {
		delete process.env.GITLAB_TOKEN;
		await expect(
			createMergeRequest({
				namespace: "org",
				project: "repo",
				sourceBranch: "feat/x",
				targetBranch: "main",
				title: "title",
				description: "desc",
			}),
		).rejects.toThrow("GITLAB_TOKEN is not set");
	});

	it("throws on API error response", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: false,
			status: 422,
			text: async () => "Branch already exists",
		});

		await expect(
			createMergeRequest({
				namespace: "org",
				project: "repo",
				sourceBranch: "feat/x",
				targetBranch: "main",
				title: "title",
				description: "desc",
			}),
		).rejects.toThrow("GitLab API error (422)");
	});
});

describe("appendMrAttribution", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env.GITLAB_TOKEN = "test-token";
	});

	afterEach(() => {
		delete process.env.GITLAB_TOKEN;
	});

	it("appends attribution to MR description", async () => {
		mockFetch
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ description: "## Summary\n- Added feature" }),
			})
			.mockResolvedValueOnce({ ok: true });

		await appendMrAttribution("https://gitlab.com/myorg/myrepo/-/merge_requests/42", "claude");

		const [, putOptions] = mockFetch.mock.calls[1] as [string, RequestInit];
		expect(putOptions.method).toBe("PUT");
		const body = JSON.parse(putOptions.body as string) as { description: string };
		expect(body.description).toContain("lisa");
		expect(body.description).toContain("Claude Code");
	});

	it("is non-fatal when GITLAB_TOKEN is not set", async () => {
		delete process.env.GITLAB_TOKEN;
		await expect(
			appendMrAttribution("https://gitlab.com/org/repo/-/merge_requests/1", "claude"),
		).resolves.toBeUndefined();
	});

	it("is non-fatal when MR URL does not match expected format", async () => {
		await expect(
			appendMrAttribution("https://not-gitlab.com/pr/1", "claude"),
		).resolves.toBeUndefined();
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("is non-fatal when fetch fails", async () => {
		mockFetch.mockRejectedValueOnce(new Error("Network error"));
		await expect(
			appendMrAttribution("https://gitlab.com/org/repo/-/merge_requests/5", "claude"),
		).resolves.toBeUndefined();
	});
});

describe("isGitLabUrl", () => {
	it("returns true for GitLab MR URL", () => {
		expect(isGitLabUrl("https://gitlab.com/org/repo/-/merge_requests/1")).toBe(true);
	});

	it("returns false for non-GitLab URL", () => {
		expect(isGitLabUrl("https://github.com/org/repo/pull/1")).toBe(false);
	});

	it("returns false for GitLab URL without merge_requests path", () => {
		expect(isGitLabUrl("https://gitlab.com/org/repo")).toBe(false);
	});
});
