import { execSync } from "node:child_process";
import type { Dirent } from "node:fs";
import { existsSync, readdirSync } from "node:fs";
import * as clack from "@clack/prompts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { detectGitRepos, detectPlatformFromRemoteUrl, fetchOpenCodeModels } from "./detection.js";

vi.mock("node:child_process", () => ({ execSync: vi.fn() }));

vi.mock("node:fs", () => ({
	existsSync: vi.fn(),
	readdirSync: vi.fn(),
	readFileSync: vi.fn(() => JSON.stringify({ version: "0.0.0" })),
}));

vi.mock("@clack/prompts", () => ({
	multiselect: vi.fn(),
	log: { info: vi.fn() },
	isCancel: vi.fn(() => false),
	select: vi.fn(),
}));

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

describe("detectGitRepos", () => {
	const cwd = process.cwd();

	function fakeDir(name: string): Dirent {
		return { name, isDirectory: () => true } as unknown as Dirent;
	}

	beforeEach(() => {
		vi.resetAllMocks();
		vi.mocked(clack.isCancel).mockReturnValue(false);
		vi.mocked(execSync).mockReturnValue("");
	});

	it("returns empty array when current dir is a git repo", async () => {
		vi.mocked(existsSync).mockImplementation((p) => String(p) === `${cwd}/.git`);
		const result = await detectGitRepos();
		expect(result).toEqual([]);
		expect(clack.multiselect).not.toHaveBeenCalled();
	});

	it("returns empty array when no subdirectory git repos found and no existing repos", async () => {
		vi.mocked(existsSync).mockReturnValue(false);
		vi.mocked(readdirSync).mockReturnValue([]);
		const result = await detectGitRepos();
		expect(result).toEqual([]);
		expect(clack.multiselect).not.toHaveBeenCalled();
	});

	it("pre-selects existing repos that are still on disk", async () => {
		vi.mocked(existsSync).mockImplementation((p) => {
			const s = String(p);
			if (s === `${cwd}/.git`) return false;
			return s.endsWith("/.git");
		});
		vi.mocked(readdirSync).mockReturnValue([
			fakeDir("repo-a"),
			fakeDir("repo-b"),
		] as unknown as ReturnType<typeof readdirSync>);
		vi.mocked(clack.multiselect).mockResolvedValue(["repo-a"]);

		const existingRepos = [{ name: "repo-a", path: "./repo-a", match: "", base_branch: "" }];
		await detectGitRepos(existingRepos);

		expect(clack.multiselect).toHaveBeenCalledWith(
			expect.objectContaining({
				initialValues: ["repo-a"],
			}),
		);
	});

	it("does not include missing repos in initialValues", async () => {
		vi.mocked(existsSync).mockImplementation((p) => {
			const s = String(p);
			if (s === `${cwd}/.git`) return false;
			return s.includes("repo-b") && s.endsWith("/.git");
		});
		vi.mocked(readdirSync).mockReturnValue([fakeDir("repo-b")] as unknown as ReturnType<
			typeof readdirSync
		>);
		vi.mocked(clack.multiselect).mockResolvedValue(["repo-b"]);

		const existingRepos = [
			{ name: "repo-a", path: "./repo-a", match: "", base_branch: "" },
			{ name: "repo-b", path: "./repo-b", match: "", base_branch: "" },
		];
		await detectGitRepos(existingRepos);

		expect(vi.mocked(clack.multiselect)).toHaveBeenCalledWith(
			expect.objectContaining({ initialValues: expect.arrayContaining(["repo-b"]) }),
		);
		expect(vi.mocked(clack.multiselect)).not.toHaveBeenCalledWith(
			expect.objectContaining({ initialValues: expect.arrayContaining(["repo-a"]) }),
		);
	});

	it("shows missing repos as disabled with hint", async () => {
		vi.mocked(existsSync).mockImplementation((p) => {
			const s = String(p);
			if (s === `${cwd}/.git`) return false;
			return s.includes("repo-b") && s.endsWith("/.git");
		});
		vi.mocked(readdirSync).mockReturnValue([fakeDir("repo-b")] as unknown as ReturnType<
			typeof readdirSync
		>);
		vi.mocked(clack.multiselect).mockResolvedValue(["repo-b"]);

		const existingRepos = [
			{ name: "repo-a", path: "./repo-a", match: "", base_branch: "" },
			{ name: "repo-b", path: "./repo-b", match: "", base_branch: "" },
		];
		await detectGitRepos(existingRepos);

		expect(vi.mocked(clack.multiselect)).toHaveBeenCalledWith(
			expect.objectContaining({
				options: expect.arrayContaining([
					expect.objectContaining({ value: "repo-a", disabled: true, hint: "(not found on disk)" }),
					expect.objectContaining({ value: "repo-b", disabled: false }),
				]),
			}),
		);
	});

	it("does not include missing repos in returned result", async () => {
		vi.mocked(existsSync).mockImplementation((p) => {
			const s = String(p);
			if (s === `${cwd}/.git`) return false;
			return s.includes("repo-b") && s.endsWith("/.git");
		});
		vi.mocked(readdirSync).mockReturnValue([fakeDir("repo-b")] as unknown as ReturnType<
			typeof readdirSync
		>);
		vi.mocked(clack.multiselect).mockResolvedValue(["repo-b"]);

		const existingRepos = [{ name: "repo-a", path: "./repo-a", match: "", base_branch: "" }];
		const result = await detectGitRepos(existingRepos);

		expect(result.map((r) => r.path)).not.toContain("./repo-a");
	});

	it("shows prompt with only-disabled options when all configured repos are missing", async () => {
		vi.mocked(existsSync).mockReturnValue(false);
		vi.mocked(readdirSync).mockReturnValue([]);
		vi.mocked(clack.multiselect).mockResolvedValue([]);

		const existingRepos = [{ name: "repo-a", path: "./repo-a", match: "", base_branch: "" }];
		const result = await detectGitRepos(existingRepos);

		expect(clack.multiselect).toHaveBeenCalled();
		expect(result).toEqual([]);
	});

	it("preserves match and base_branch from existing config for re-selected repos", async () => {
		vi.mocked(existsSync).mockImplementation((p) => {
			const s = String(p);
			if (s === `${cwd}/.git`) return false;
			return s.endsWith("/.git");
		});
		vi.mocked(readdirSync).mockReturnValue([fakeDir("repo-a")] as unknown as ReturnType<
			typeof readdirSync
		>);
		vi.mocked(clack.multiselect).mockResolvedValue(["repo-a"]);

		const existingRepos = [
			{ name: "repo-a", path: "./repo-a", match: "AUTH:", base_branch: "develop" },
		];
		const result = await detectGitRepos(existingRepos);

		expect(result[0]).toMatchObject({ path: "./repo-a", match: "AUTH:", base_branch: "develop" });
	});
});
