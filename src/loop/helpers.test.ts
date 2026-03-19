import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("execa", () => ({
	execa: vi.fn(),
}));

vi.mock("../output/logger.js", () => ({
	log: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	ok: vi.fn(),
}));

vi.mock("./state.js", () => ({
	activeProviderPids: new Map<string, number>(),
	reconciliationSet: new Set<string>(),
	userKilledSet: new Set<string>(),
	userSkippedSet: new Set<string>(),
	isLoopPaused: vi.fn(() => false),
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		appendFileSync: vi.fn(),
	};
});

import { execa } from "execa";
import * as logger from "../output/logger.js";
import type { FallbackResult, Issue, LisaConfig, ModelSpec } from "../types/index.js";
import {
	appendSessionLog,
	buildRunOptions,
	checkoutBaseBranches,
	checkReconciliation,
	defaultProvider,
	emptyCommitFailure,
	failureResult,
	hookFailure,
	resolveBaseBranch,
	resolveProviderOptions,
	sleep,
} from "./helpers.js";
import { reconciliationSet, userKilledSet, userSkippedSet } from "./state.js";

function makeConfig(overrides: Partial<LisaConfig> = {}): LisaConfig {
	return {
		provider: "claude",
		source: "linear",
		source_config: {
			scope: "t",
			project: "p",
			label: "ready",
			pick_from: "todo",
			in_progress: "in_progress",
			done: "done",
		},
		platform: "cli",
		workflow: "branch",
		workspace: "/workspace",
		base_branch: "main",
		repos: [],
		loop: { cooldown: 0, max_sessions: 1 },
		...overrides,
	} as LisaConfig;
}

describe("checkoutBaseBranches", () => {
	beforeEach(() => {
		vi.mocked(execa).mockResolvedValue({ stdout: "", stderr: "" } as never);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("checks out base_branch in the workspace when no repos configured", async () => {
		const config = makeConfig({ workspace: "/workspace", base_branch: "main", repos: [] });
		await checkoutBaseBranches(config, "/workspace");
		expect(execa).toHaveBeenCalledWith("git", ["checkout", "main"], { cwd: "/workspace" });
		expect(execa).toHaveBeenCalledTimes(1);
	});

	it("checks out base_branch in workspace and each configured repo", async () => {
		const appPath = resolve("/workspace", "./app");
		const apiPath = resolve("/workspace", "./api");
		const config = makeConfig({
			workspace: "/workspace",
			base_branch: "main",
			repos: [
				{ name: "app", path: "./app", match: "App:", base_branch: "develop" },
				{ name: "api", path: "./api", match: "API:", base_branch: "main" },
			],
		});
		await checkoutBaseBranches(config, "/workspace");
		expect(execa).toHaveBeenCalledWith("git", ["checkout", "main"], { cwd: "/workspace" });
		expect(execa).toHaveBeenCalledWith("git", ["checkout", "develop"], { cwd: appPath });
		expect(execa).toHaveBeenCalledWith("git", ["checkout", "main"], { cwd: apiPath });
		expect(execa).toHaveBeenCalledTimes(3);
	});

	it("continues when checkout fails", async () => {
		vi.mocked(execa).mockRejectedValueOnce(new Error("dirty working tree"));
		const config = makeConfig({ workspace: "/workspace", base_branch: "main", repos: [] });
		await expect(checkoutBaseBranches(config, "/workspace")).resolves.toBeUndefined();
	});
});

describe("defaultProvider", () => {
	it("returns first model's provider", () => {
		const models: ModelSpec[] = [
			{ provider: "gemini", model: "gemini-2.5-pro" },
			{ provider: "claude", model: "claude-sonnet-4-6" },
		];
		expect(defaultProvider(models)).toBe("gemini");
	});

	it('returns "claude" when models array is empty', () => {
		expect(defaultProvider([])).toBe("claude");
	});
});

describe("failureResult", () => {
	it("returns SessionResult with success=false and empty prUrls", () => {
		const fallback: FallbackResult = {
			success: false,
			output: "error output",
			duration: 1000,
			providerUsed: "claude",
			attempts: [],
		};
		const result = failureResult("claude", fallback);
		expect(result.success).toBe(false);
		expect(result.prUrls).toEqual([]);
		expect(result.providerUsed).toBe("claude");
		expect(result.fallback).toBe(fallback);
	});
});

describe("hookFailure", () => {
	it("returns failure with the hook message in output", () => {
		const result = hookFailure("gemini", "pre-push hook failed");
		expect(result.success).toBe(false);
		expect(result.fallback.output).toBe("pre-push hook failed");
		expect(result.fallback.duration).toBe(0);
		expect(result.fallback.providerUsed).toBe("gemini");
		expect(result.fallback.attempts).toEqual([]);
		expect(result.prUrls).toEqual([]);
	});
});

describe("emptyCommitFailure", () => {
	it('returns failure with "empty commit" error type', () => {
		const fallback: FallbackResult = {
			success: true,
			output: "done",
			duration: 5000,
			providerUsed: "claude",
			attempts: [],
		};
		const result = emptyCommitFailure(fallback);
		expect(result.success).toBe(false);
		expect(result.fallback.success).toBe(false);
		expect(result.fallback.attempts[0]?.error).toBe("Eligible error (empty commit)");
	});

	it("logs error message", () => {
		const fallback: FallbackResult = {
			success: true,
			output: "done",
			duration: 5000,
			providerUsed: "claude",
			attempts: [],
		};
		emptyCommitFailure(fallback);
		expect(logger.error).toHaveBeenCalledWith(
			"Provider reported success but no code changes detected. Treating as failure.",
		);
	});
});

describe("appendSessionLog", () => {
	it("appends to file without throwing on error", () => {
		const fallback: FallbackResult = {
			success: true,
			output: "session output",
			duration: 3000,
			providerUsed: "claude",
			attempts: [],
		};
		expect(() => appendSessionLog("/tmp/test.log", fallback)).not.toThrow();
		expect(appendFileSync).toHaveBeenCalledWith(
			"/tmp/test.log",
			expect.stringContaining("Provider used: claude"),
		);
	});

	it("handles write errors silently", () => {
		vi.mocked(appendFileSync).mockImplementation(() => {
			throw new Error("EACCES");
		});
		const fallback: FallbackResult = {
			success: true,
			output: "output",
			duration: 1000,
			providerUsed: "claude",
			attempts: [],
		};
		expect(() => appendSessionLog("/readonly/file.log", fallback)).not.toThrow();
	});
});

describe("checkReconciliation", () => {
	afterEach(() => {
		reconciliationSet.clear();
	});

	it("returns null when issue is not in reconciliation set", () => {
		const fallback: FallbackResult = {
			success: true,
			output: "output",
			duration: 1000,
			providerUsed: "claude",
			attempts: [],
		};
		expect(checkReconciliation("ISSUE-1", fallback)).toBeNull();
	});

	it("returns failure result when issue is reconciled", () => {
		reconciliationSet.add("ISSUE-2");
		const fallback: FallbackResult = {
			success: true,
			output: "output",
			duration: 1000,
			providerUsed: "claude",
			attempts: [],
		};
		const result = checkReconciliation("ISSUE-2", fallback);
		expect(result).not.toBeNull();
		expect(result?.success).toBe(false);
		expect(result?.providerUsed).toBe("claude");
	});

	it("removes issue from reconciliation set", () => {
		reconciliationSet.add("ISSUE-3");
		const fallback: FallbackResult = {
			success: true,
			output: "output",
			duration: 1000,
			providerUsed: "claude",
			attempts: [],
		};
		checkReconciliation("ISSUE-3", fallback);
		expect(reconciliationSet.has("ISSUE-3")).toBe(false);
	});
});

describe("buildRunOptions", () => {
	afterEach(() => {
		userKilledSet.clear();
		userSkippedSet.clear();
	});

	const issue: Issue = {
		id: "ISSUE-1",
		title: "Test issue",
		description: "desc",
		url: "https://example.com/issue/1",
	};

	it("includes all standard fields from config", () => {
		const config = makeConfig({
			overseer: { enabled: true, check_interval: 30, stuck_threshold: 300 },
			loop: { cooldown: 0, max_sessions: 1, session_timeout: 600, output_stall_timeout: 120 },
		});
		const opts = buildRunOptions(config, issue, "/work", "/tmp/log.txt", "/workspace", {});
		expect(opts.logFile).toBe("/tmp/log.txt");
		expect(opts.cwd).toBe("/work");
		expect(opts.guardrailsDir).toBe("/workspace");
		expect(opts.issueId).toBe("ISSUE-1");
		expect(opts.overseer).toEqual({ enabled: true, check_interval: 30, stuck_threshold: 300 });
		expect(opts.sessionTimeout).toBe(600);
		expect(opts.outputStallTimeout).toBe(120);
	});

	it("merges extra options", () => {
		const config = makeConfig();
		const opts = buildRunOptions(
			config,
			issue,
			"/work",
			"/tmp/log.txt",
			"/workspace",
			{},
			{
				useNativeWorktree: true,
				model: "claude-sonnet-4-6",
			},
		);
		expect(opts.useNativeWorktree).toBe(true);
		expect(opts.model).toBe("claude-sonnet-4-6");
	});

	it("sets shouldAbort based on killed/skipped sets", () => {
		const config = makeConfig();
		const opts = buildRunOptions(config, issue, "/work", "/tmp/log.txt", "/workspace", {});
		expect(opts.shouldAbort?.()).toBe(false);

		userKilledSet.add("ISSUE-1");
		expect(opts.shouldAbort?.()).toBe(true);

		userKilledSet.delete("ISSUE-1");
		userSkippedSet.add("ISSUE-1");
		expect(opts.shouldAbort?.()).toBe(true);
	});
});

describe("resolveProviderOptions", () => {
	it("returns undefined when no provider_options configured", () => {
		const config = makeConfig();
		expect(resolveProviderOptions(config)).toBeUndefined();
	});

	it("returns undefined when provider has no effort setting", () => {
		const config = makeConfig({
			provider_options: { claude: {} },
		} as Partial<LisaConfig>);
		expect(resolveProviderOptions(config)).toBeUndefined();
	});

	it("returns effort when configured for the active provider", () => {
		const config = makeConfig({
			provider_options: { claude: { effort: "low" } },
		} as Partial<LisaConfig>);
		expect(resolveProviderOptions(config)).toEqual({ effort: "low" });
	});
});

describe("resolveBaseBranch", () => {
	it("returns config.base_branch when no repos match", () => {
		const config = makeConfig({ base_branch: "main", repos: [] });
		expect(resolveBaseBranch(config, "/some/path")).toBe("main");
	});

	it("returns repo-specific base_branch when repo path matches", () => {
		const config = makeConfig({
			workspace: "/workspace",
			base_branch: "main",
			repos: [{ name: "app", path: "./app", match: "", base_branch: "develop" }],
		});
		expect(resolveBaseBranch(config, resolve("/workspace", "./app"))).toBe("develop");
	});
});

describe("sleep", () => {
	it("resolves after the specified delay", async () => {
		const start = Date.now();
		await sleep(50);
		expect(Date.now() - start).toBeGreaterThanOrEqual(40);
	});
});
