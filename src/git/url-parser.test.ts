import { describe, expect, it } from "vitest";
import { parseBitbucketPrUrl, parseGitHubPrUrl, parseGitLabMrUrl } from "./url-parser.js";

describe("parseGitHubPrUrl", () => {
	it("parses a standard GitHub PR URL", () => {
		const result = parseGitHubPrUrl("https://github.com/octocat/hello-world/pull/42");
		expect(result).toEqual({ owner: "octocat", repo: "hello-world", number: 42 });
	});

	it("returns null for non-GitHub URL", () => {
		expect(parseGitHubPrUrl("https://gitlab.com/ns/proj/-/merge_requests/1")).toBeNull();
	});

	it("returns null for malformed URL", () => {
		expect(parseGitHubPrUrl("not a url")).toBeNull();
	});

	it("handles URL with trailing content", () => {
		const result = parseGitHubPrUrl("https://github.com/owner/repo/pull/7/files");
		expect(result).toEqual({ owner: "owner", repo: "repo", number: 7 });
	});
});

describe("parseGitLabMrUrl", () => {
	it("parses a standard GitLab MR URL", () => {
		const result = parseGitLabMrUrl("https://gitlab.com/namespace/project/-/merge_requests/99");
		expect(result).toEqual({ host: "gitlab.com", projectPath: "namespace/project", iid: 99 });
	});

	it("parses a self-hosted GitLab URL", () => {
		const result = parseGitLabMrUrl("https://git.example.com/team/sub/project/-/merge_requests/5");
		expect(result).toEqual({ host: "git.example.com", projectPath: "team/sub/project", iid: 5 });
	});

	it("returns null for non-GitLab URL", () => {
		expect(parseGitLabMrUrl("https://github.com/owner/repo/pull/1")).toBeNull();
	});
});

describe("parseBitbucketPrUrl", () => {
	it("parses a standard Bitbucket PR URL", () => {
		const result = parseBitbucketPrUrl(
			"https://bitbucket.org/workspace/repo-slug/pull-requests/15",
		);
		expect(result).toEqual({ workspace: "workspace", repoSlug: "repo-slug", id: 15 });
	});

	it("returns null for non-Bitbucket URL", () => {
		expect(parseBitbucketPrUrl("https://github.com/owner/repo/pull/1")).toBeNull();
	});
});
