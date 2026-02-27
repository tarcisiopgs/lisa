import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	appendPrAttribution,
	createPullRequest,
	getBitbucketRepoInfo,
	isBitbucketUrl,
} from "./bitbucket.js";

// Mock execa
const mockExeca = vi.fn();
vi.mock("execa", () => ({
	execa: (...args: unknown[]) => mockExeca(...args),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("getBitbucketRepoInfo", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("parses SSH remote URL", async () => {
		mockExeca.mockImplementation((_cmd: string, args: string[]) => {
			if (args[0] === "remote" && args[1] === "get-url") {
				return Promise.resolve({ stdout: "git@bitbucket.org:myworkspace/myrepo.git" });
			}
			if (args[0] === "branch" && args[1] === "--show-current") {
				return Promise.resolve({ stdout: "feat/my-branch" });
			}
			if (args[0] === "symbolic-ref") {
				return Promise.resolve({ stdout: "origin/main" });
			}
			return Promise.resolve({ stdout: "" });
		});

		const info = await getBitbucketRepoInfo("/some/cwd");

		expect(info.workspace).toBe("myworkspace");
		expect(info.repoSlug).toBe("myrepo");
		expect(info.branch).toBe("feat/my-branch");
		expect(info.defaultBranch).toBe("main");
	});

	it("parses HTTPS remote URL", async () => {
		mockExeca.mockImplementation((_cmd: string, args: string[]) => {
			if (args[0] === "remote" && args[1] === "get-url") {
				return Promise.resolve({
					stdout: "https://bitbucket.org/myworkspace/myrepo.git",
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

		const info = await getBitbucketRepoInfo("/some/cwd");

		expect(info.workspace).toBe("myworkspace");
		expect(info.repoSlug).toBe("myrepo");
	});

	it("parses HTTPS URL with username", async () => {
		mockExeca.mockImplementation((_cmd: string, args: string[]) => {
			if (args[0] === "remote" && args[1] === "get-url") {
				return Promise.resolve({
					stdout: "https://user@bitbucket.org/myworkspace/myrepo.git",
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

		const info = await getBitbucketRepoInfo("/some/cwd");

		expect(info.workspace).toBe("myworkspace");
		expect(info.repoSlug).toBe("myrepo");
	});

	it("throws on unrecognized remote URL", async () => {
		mockExeca.mockImplementation((_cmd: string, args: string[]) => {
			if (args[0] === "remote" && args[1] === "get-url") {
				return Promise.resolve({ stdout: "https://github.com/org/repo.git" });
			}
			return Promise.resolve({ stdout: "" });
		});

		await expect(getBitbucketRepoInfo("/some/cwd")).rejects.toThrow(
			"Cannot parse Bitbucket workspace/repo from remote URL",
		);
	});
});

describe("createPullRequest", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env.BITBUCKET_TOKEN = "test-token";
	});

	afterEach(() => {
		delete process.env.BITBUCKET_TOKEN;
	});

	it("creates a pull request via Bitbucket API", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				id: 7,
				links: { html: { href: "https://bitbucket.org/myworkspace/myrepo/pull-requests/7" } },
			}),
		});

		const result = await createPullRequest({
			workspace: "myworkspace",
			repoSlug: "myrepo",
			sourceBranch: "feat/new-feature",
			destinationBranch: "main",
			title: "feat: add new feature",
			description: "Adds a new feature",
		});

		expect(result.id).toBe(7);
		expect(result.html_url).toBe("https://bitbucket.org/myworkspace/myrepo/pull-requests/7");

		const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
		expect(url).toContain("api.bitbucket.org");
		expect(url).toContain("pullrequests");
		expect(options.method).toBe("POST");
		expect(options.headers).toMatchObject({ Authorization: "Bearer test-token" });
	});

	it("throws when BITBUCKET_TOKEN is not set", async () => {
		delete process.env.BITBUCKET_TOKEN;
		await expect(
			createPullRequest({
				workspace: "ws",
				repoSlug: "repo",
				sourceBranch: "feat/x",
				destinationBranch: "main",
				title: "title",
				description: "desc",
			}),
		).rejects.toThrow("BITBUCKET_TOKEN is not set");
	});

	it("throws on API error response", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: false,
			status: 400,
			text: async () => "Bad request",
		});

		await expect(
			createPullRequest({
				workspace: "ws",
				repoSlug: "repo",
				sourceBranch: "feat/x",
				destinationBranch: "main",
				title: "title",
				description: "desc",
			}),
		).rejects.toThrow("Bitbucket API error (400)");
	});
});

describe("appendPrAttribution", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env.BITBUCKET_TOKEN = "test-token";
	});

	afterEach(() => {
		delete process.env.BITBUCKET_TOKEN;
	});

	it("appends attribution to PR description", async () => {
		mockFetch
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ description: "## Summary\n- Added feature" }),
			})
			.mockResolvedValueOnce({ ok: true });

		await appendPrAttribution("https://bitbucket.org/myworkspace/myrepo/pull-requests/7", "claude");

		const [, putOptions] = mockFetch.mock.calls[1] as [string, RequestInit];
		expect(putOptions.method).toBe("PUT");
		const body = JSON.parse(putOptions.body as string) as { description: string };
		expect(body.description).toContain("lisa");
		expect(body.description).toContain("Claude Code");
	});

	it("is non-fatal when BITBUCKET_TOKEN is not set", async () => {
		delete process.env.BITBUCKET_TOKEN;
		await expect(
			appendPrAttribution("https://bitbucket.org/ws/repo/pull-requests/1", "claude"),
		).resolves.toBeUndefined();
	});

	it("is non-fatal when PR URL does not match expected format", async () => {
		await expect(
			appendPrAttribution("https://not-bitbucket.com/pr/1", "claude"),
		).resolves.toBeUndefined();
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("is non-fatal when fetch fails", async () => {
		mockFetch.mockRejectedValueOnce(new Error("Network error"));
		await expect(
			appendPrAttribution("https://bitbucket.org/ws/repo/pull-requests/5", "claude"),
		).resolves.toBeUndefined();
	});
});

describe("isBitbucketUrl", () => {
	it("returns true for Bitbucket PR URL", () => {
		expect(isBitbucketUrl("https://bitbucket.org/ws/repo/pull-requests/1")).toBe(true);
	});

	it("returns false for non-Bitbucket URL", () => {
		expect(isBitbucketUrl("https://github.com/org/repo/pull/1")).toBe(false);
	});

	it("returns false for Bitbucket URL without pull-requests path", () => {
		expect(isBitbucketUrl("https://bitbucket.org/ws/repo")).toBe(false);
	});
});
