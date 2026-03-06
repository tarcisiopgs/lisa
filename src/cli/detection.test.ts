import { execSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { detectPlatformFromRemoteUrl, fetchOpenCodeModels } from "./detection.js";

vi.mock("node:child_process", () => ({ execSync: vi.fn() }));

describe("fetchOpenCodeModels", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	it("returns all provider/model lines from opencode models output", () => {
		vi.mocked(execSync).mockReturnValue(
			"anthropic/claude-sonnet-4-6\nopenrouter/qwen/qwen3-coder:free\nopencode/kimi-k2\n",
		);
		const result = fetchOpenCodeModels();
		expect(result).toEqual([
			"anthropic/claude-sonnet-4-6",
			"openrouter/qwen/qwen3-coder:free",
			"opencode/kimi-k2",
		]);
	});

	it("includes openrouter models regardless of OPENROUTER_API_KEY", () => {
		vi.mocked(execSync).mockReturnValue(
			"openrouter/google/gemini-2.5-flash\nopenrouter/arcee-ai/trinity-large-preview:free\n",
		);
		const result = fetchOpenCodeModels();
		expect(result).toContain("openrouter/google/gemini-2.5-flash");
		expect(result).toContain("openrouter/arcee-ai/trinity-large-preview:free");
	});

	it("filters out blank lines and lines without a slash", () => {
		vi.mocked(execSync).mockReturnValue(
			"\nanthropic/claude-sonnet-4-6\n\nsomegarbage\nhttps://opencode.ai/docs\n/usr/local/bin/opencode\nopencode/kimi-k2\n",
		);
		const result = fetchOpenCodeModels();
		expect(result).toEqual(["anthropic/claude-sonnet-4-6", "opencode/kimi-k2"]);
	});

	it("returns empty array when opencode models command fails", () => {
		vi.mocked(execSync).mockImplementation(() => {
			throw new Error("command not found: opencode");
		});
		const result = fetchOpenCodeModels();
		expect(result).toEqual([]);
	});
});

describe("detectPlatformFromRemoteUrl", () => {
	it("detects GitHub SSH remote", () => {
		expect(detectPlatformFromRemoteUrl("git@github.com:org/repo.git")).toBe("cli");
	});

	it("detects GitHub HTTPS remote", () => {
		expect(detectPlatformFromRemoteUrl("https://github.com/org/repo.git")).toBe("cli");
	});

	it("detects GitLab SSH remote", () => {
		expect(detectPlatformFromRemoteUrl("git@gitlab.com:org/repo.git")).toBe("gitlab");
	});

	it("detects GitLab HTTPS remote", () => {
		expect(detectPlatformFromRemoteUrl("https://gitlab.com/org/repo.git")).toBe("gitlab");
	});

	it("detects self-hosted GitLab", () => {
		expect(detectPlatformFromRemoteUrl("https://gitlab.mycompany.com/org/repo.git")).toBe("gitlab");
	});

	it("detects Bitbucket SSH remote", () => {
		expect(detectPlatformFromRemoteUrl("git@bitbucket.org:workspace/repo.git")).toBe("bitbucket");
	});

	it("detects Bitbucket HTTPS remote", () => {
		expect(detectPlatformFromRemoteUrl("https://bitbucket.org/workspace/repo.git")).toBe(
			"bitbucket",
		);
	});

	it("returns null for unknown remote", () => {
		expect(detectPlatformFromRemoteUrl("https://codeberg.org/org/repo.git")).toBeNull();
	});
});
