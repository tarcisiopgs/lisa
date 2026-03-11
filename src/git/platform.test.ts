import { describe, expect, it, vi } from "vitest";
import { appendPlatformAttribution, buildPrCreateInstruction } from "./platform.js";

vi.mock("./github.js", () => ({
	appendPrAttribution: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./gitlab.js", () => ({
	appendMrAttribution: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./bitbucket.js", () => ({
	appendPrAttribution: vi.fn().mockResolvedValue(undefined),
}));

describe("appendPlatformAttribution", () => {
	it("routes to GitHub for 'cli' platform", async () => {
		const { appendPrAttribution } = await import("./github.js");
		await appendPlatformAttribution("https://github.com/org/repo/pull/1", "claude", "cli");
		expect(appendPrAttribution).toHaveBeenCalledWith(
			"https://github.com/org/repo/pull/1",
			"claude",
		);
	});

	it("routes to GitHub for 'token' platform", async () => {
		const { appendPrAttribution } = await import("./github.js");
		await appendPlatformAttribution("https://github.com/org/repo/pull/1", "claude", "token");
		expect(appendPrAttribution).toHaveBeenCalledWith(
			"https://github.com/org/repo/pull/1",
			"claude",
		);
	});

	it("routes to GitLab for 'gitlab' platform", async () => {
		const { appendMrAttribution } = await import("./gitlab.js");
		await appendPlatformAttribution(
			"https://gitlab.com/org/repo/-/merge_requests/1",
			"claude",
			"gitlab",
		);
		expect(appendMrAttribution).toHaveBeenCalledWith(
			"https://gitlab.com/org/repo/-/merge_requests/1",
			"claude",
		);
	});

	it("routes to Bitbucket for 'bitbucket' platform", async () => {
		const { appendPrAttribution } = await import("./bitbucket.js");
		await appendPlatformAttribution(
			"https://bitbucket.org/ws/repo/pull-requests/1",
			"claude",
			"bitbucket",
		);
		expect(appendPrAttribution).toHaveBeenCalledWith(
			"https://bitbucket.org/ws/repo/pull-requests/1",
			"claude",
		);
	});
});

describe("buildPrCreateInstruction", () => {
	it("returns GitHub CLI instruction for 'cli' platform", () => {
		const instruction = buildPrCreateInstruction("cli", "main");
		expect(instruction).toContain("gh pr create");
		expect(instruction).toContain("--base main");
		expect(instruction).not.toContain("gitlab");
		expect(instruction).not.toContain("bitbucket");
	});

	it("returns GitHub CLI instruction for 'token' platform", () => {
		const instruction = buildPrCreateInstruction("token", "main");
		expect(instruction).toContain("gh pr create");
	});

	it("returns GitLab instruction for 'gitlab' platform", () => {
		const instruction = buildPrCreateInstruction("gitlab", "main");
		expect(instruction).toContain("glab mr create");
		expect(instruction).toContain("GITLAB_TOKEN");
		expect(instruction).toContain("merge_requests");
		expect(instruction).not.toContain("gh pr create");
	});

	it("returns Bitbucket instruction for 'bitbucket' platform", () => {
		const instruction = buildPrCreateInstruction("bitbucket", "main");
		expect(instruction).toContain("BITBUCKET_TOKEN");
		expect(instruction).toContain("api.bitbucket.org");
		expect(instruction).toContain("pullrequests");
		expect(instruction).not.toContain("gh pr create");
	});

	it("omits base branch in GitHub instruction when targetBranch is undefined", () => {
		const instruction = buildPrCreateInstruction("cli", undefined);
		expect(instruction).not.toContain("--base");
	});

	it("includes target branch in GitLab instruction", () => {
		const instruction = buildPrCreateInstruction("gitlab", "develop");
		expect(instruction).toContain("develop");
	});

	it("includes destination branch in Bitbucket instruction", () => {
		const instruction = buildPrCreateInstruction("bitbucket", "develop");
		expect(instruction).toContain("develop");
	});
});
