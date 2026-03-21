import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isProofOfWorkEnabled } from "../session/proof-of-work.js";
import type { FallbackResult, Issue, LisaConfig, ProofOfWorkConfig } from "../types/index.js";
import {
	buildRunOptions,
	defaultProvider,
	emptyCommitFailure,
	failureResult,
	hookFailure,
} from "./helpers.js";

vi.mock("../output/logger.js", () => ({
	error: vi.fn(),
	warn: vi.fn(),
	ok: vi.fn(),
	info: vi.fn(),
	verbose: vi.fn(),
}));

vi.mock("../output/terminal.js", () => ({
	startSpinner: vi.fn(),
	stopSpinner: vi.fn(),
}));

vi.mock("../ui/state.js", () => ({
	kanbanEmitter: { listenerCount: vi.fn().mockReturnValue(0), emit: vi.fn() },
}));

vi.mock("./state.js", () => ({
	activeProviderPids: new Map(),
	isLoopPaused: vi.fn().mockReturnValue(false),
	reconciliationSet: new Set(),
	userKilledSet: new Set(),
	userSkippedSet: new Set(),
}));

// We need to mock isProofOfWorkEnabled separately since it's re-exported
vi.mock("../session/proof-of-work.js", () => ({
	isProofOfWorkEnabled: (config?: ProofOfWorkConfig) =>
		!!(config?.enabled && config.commands.length > 0),
	runValidationCommands: vi.fn(),
	buildValidationRecoveryPrompt: vi.fn(),
}));

vi.mock("../providers/index.js", () => ({
	runWithFallback: vi.fn(),
}));

vi.mock("../session/discovery.js", () => ({
	discoverInfra: vi.fn(),
}));

vi.mock("../session/lifecycle.js", () => ({
	runLifecycle: vi.fn(),
	stopResources: vi.fn(),
}));

vi.mock("../session/reconciliation.js", () => ({
	startReconciliation: vi.fn(),
}));

vi.mock("../validation.js", () => ({
	validateIssueSpec: vi.fn().mockReturnValue({ valid: true }),
}));

const makeIssue = (overrides?: Partial<Issue>): Issue => ({
	id: "ISSUE-1",
	title: "Test issue",
	description: "A test issue description",
	url: "https://example.com/issue/1",
	...overrides,
});

const makeConfig = (overrides?: Partial<LisaConfig>): LisaConfig => ({
	provider: "claude",
	source: "linear",
	source_config: {
		scope: "Engineering",
		project: "Backend",
		label: "lisa",
		pick_from: "Backlog",
		in_progress: "In Progress",
		done: "Done",
	},
	platform: "cli",
	workflow: "worktree",
	workspace: "/tmp/workspace",
	base_branch: "main",
	repos: [],
	loop: {
		cooldown: 5,
		max_sessions: 10,
	},
	...overrides,
});

const makeFallbackResult = (overrides?: Partial<FallbackResult>): FallbackResult => ({
	success: true,
	output: "Provider output",
	duration: 5000,
	providerUsed: "claude",
	attempts: [{ provider: "claude", model: "claude-sonnet-4-6", success: true, duration: 5000 }],
	...overrides,
});

describe("helpers — defaultProvider", () => {
	it("returns provider from first model spec", () => {
		expect(defaultProvider([{ provider: "gemini", model: "gemini-2.5-pro" }])).toBe("gemini");
	});

	it("returns 'claude' when models array is empty", () => {
		expect(defaultProvider([])).toBe("claude");
	});

	it("returns provider from first spec when multiple specs given", () => {
		expect(
			defaultProvider([
				{ provider: "claude", model: "claude-sonnet-4-6" },
				{ provider: "gemini", model: "gemini-2.5-pro" },
			]),
		).toBe("claude");
	});
});

describe("helpers — failureResult", () => {
	it("returns a SessionResult with success=false and empty prUrls", () => {
		const fallback = makeFallbackResult({ success: false });
		const result = failureResult("claude", fallback);

		expect(result).toEqual({
			success: false,
			providerUsed: "claude",
			prUrls: [],
			fallback,
		});
	});

	it("preserves the fallback object reference", () => {
		const fallback = makeFallbackResult();
		const result = failureResult("gemini", fallback);

		expect(result.fallback).toBe(fallback);
		expect(result.providerUsed).toBe("gemini");
	});
});

describe("helpers — hookFailure", () => {
	it("returns a failure result with the given message as output", () => {
		const result = hookFailure("claude", "Hook before_run failed");

		expect(result.success).toBe(false);
		expect(result.providerUsed).toBe("claude");
		expect(result.prUrls).toEqual([]);
		expect(result.fallback.success).toBe(false);
		expect(result.fallback.output).toBe("Hook before_run failed");
		expect(result.fallback.duration).toBe(0);
		expect(result.fallback.providerUsed).toBe("claude");
		expect(result.fallback.attempts).toEqual([]);
	});

	it("works with different provider names", () => {
		const result = hookFailure("gemini", "Worktree creation failed");

		expect(result.providerUsed).toBe("gemini");
		expect(result.fallback.providerUsed).toBe("gemini");
		expect(result.fallback.output).toBe("Worktree creation failed");
	});
});

describe("helpers — emptyCommitFailure", () => {
	it("returns failure with empty commit error details", () => {
		const fallback = makeFallbackResult({
			success: true,
			providerUsed: "claude",
			duration: 3000,
		});
		const result = emptyCommitFailure(fallback);

		expect(result.success).toBe(false);
		expect(result.providerUsed).toBe("claude");
		expect(result.prUrls).toEqual([]);
		expect(result.fallback.success).toBe(false);
		expect(result.fallback.output).toBe("Provider reported success but no code changes detected");
		expect(result.fallback.duration).toBe(3000);
		expect(result.fallback.attempts).toHaveLength(1);
		expect(result.fallback.attempts[0]).toEqual({
			provider: "claude",
			model: "",
			success: false,
			error: "Eligible error (empty commit)",
			duration: 3000,
		});
	});

	it("preserves the original provider name and duration", () => {
		const fallback = makeFallbackResult({
			success: true,
			providerUsed: "gemini",
			duration: 9999,
		});
		const result = emptyCommitFailure(fallback);

		expect(result.fallback.providerUsed).toBe("gemini");
		expect(result.fallback.duration).toBe(9999);
		expect(result.fallback.attempts[0]?.provider).toBe("gemini");
		expect(result.fallback.attempts[0]?.duration).toBe(9999);
	});
});

describe("helpers — isProofOfWorkEnabled", () => {
	it("returns false when config is undefined", () => {
		expect(isProofOfWorkEnabled(undefined)).toBe(false);
	});

	it("returns false when enabled is false", () => {
		expect(
			isProofOfWorkEnabled({
				enabled: false,
				commands: [{ name: "lint", run: "pnpm run lint" }],
			}),
		).toBe(false);
	});

	it("returns false when commands array is empty", () => {
		expect(isProofOfWorkEnabled({ enabled: true, commands: [] })).toBe(false);
	});

	it("returns true when enabled and commands are present", () => {
		expect(
			isProofOfWorkEnabled({
				enabled: true,
				commands: [{ name: "lint", run: "pnpm run lint" }],
			}),
		).toBe(true);
	});

	it("returns true with multiple commands", () => {
		expect(
			isProofOfWorkEnabled({
				enabled: true,
				commands: [
					{ name: "lint", run: "pnpm run lint" },
					{ name: "typecheck", run: "pnpm run typecheck" },
					{ name: "test", run: "pnpm run test" },
				],
			}),
		).toBe(true);
	});
});

describe("helpers — buildRunOptions", () => {
	let config: LisaConfig;
	let issue: Issue;

	beforeEach(() => {
		config = makeConfig();
		issue = makeIssue();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("builds RunOptions with correct fields from config", () => {
		const opts = buildRunOptions(
			config,
			issue,
			"/tmp/workspace/worktree",
			"/tmp/logs/issue.log",
			"/tmp/workspace",
			{},
		);

		expect(opts.logFile).toBe("/tmp/logs/issue.log");
		expect(opts.cwd).toBe("/tmp/workspace/worktree");
		expect(opts.guardrailsDir).toBe("/tmp/workspace");
		expect(opts.issueId).toBe("ISSUE-1");
		expect(opts.overseer).toBeUndefined();
		expect(opts.sessionTimeout).toBeUndefined();
		expect(opts.outputStallTimeout).toBeUndefined();
		expect(opts.providerOptions).toBeUndefined();
		expect(opts.env).toBeUndefined();
	});

	it("includes overseer config when present", () => {
		config.overseer = { enabled: true, check_interval: 30, stuck_threshold: 300 };
		const opts = buildRunOptions(config, issue, "/tmp/cwd", "/tmp/log", "/tmp/workspace", {});

		expect(opts.overseer).toEqual({
			enabled: true,
			check_interval: 30,
			stuck_threshold: 300,
		});
	});

	it("includes session_timeout from loop config", () => {
		config.loop.session_timeout = 600;
		const opts = buildRunOptions(config, issue, "/tmp/cwd", "/tmp/log", "/tmp/workspace", {});

		expect(opts.sessionTimeout).toBe(600);
	});

	it("includes output_stall_timeout from loop config", () => {
		config.loop.output_stall_timeout = 180;
		const opts = buildRunOptions(config, issue, "/tmp/cwd", "/tmp/log", "/tmp/workspace", {});

		expect(opts.outputStallTimeout).toBe(180);
	});

	it("includes lifecycle env when non-empty", () => {
		const opts = buildRunOptions(config, issue, "/tmp/cwd", "/tmp/log", "/tmp/workspace", {
			DATABASE_URL: "postgres://localhost:5432/test",
		});

		expect(opts.env).toEqual({ DATABASE_URL: "postgres://localhost:5432/test" });
	});

	it("sets env to undefined when lifecycle env is empty", () => {
		const opts = buildRunOptions(config, issue, "/tmp/cwd", "/tmp/log", "/tmp/workspace", {});

		expect(opts.env).toBeUndefined();
	});

	it("includes provider options when configured", () => {
		config.provider_options = { claude: { effort: "high" } };
		const opts = buildRunOptions(config, issue, "/tmp/cwd", "/tmp/log", "/tmp/workspace", {});

		expect(opts.providerOptions).toEqual({ effort: "high" });
	});

	it("merges extra options", () => {
		const opts = buildRunOptions(
			config,
			issue,
			"/tmp/cwd",
			"/tmp/log",
			"/tmp/workspace",
			{},
			{ useNativeWorktree: true, model: "claude-sonnet-4-6" },
		);

		expect(opts.useNativeWorktree).toBe(true);
		expect(opts.model).toBe("claude-sonnet-4-6");
	});

	it("provides onProcess callback that stores pid", async () => {
		const { activeProviderPids } = await import("./state.js");
		const opts = buildRunOptions(config, issue, "/tmp/cwd", "/tmp/log", "/tmp/workspace", {});

		opts.onProcess?.(12345);
		expect(activeProviderPids.get("ISSUE-1")).toBe(12345);
	});

	it("provides shouldAbort that checks killed and skipped sets", async () => {
		const { userKilledSet, userSkippedSet } = await import("./state.js");
		const opts = buildRunOptions(config, issue, "/tmp/cwd", "/tmp/log", "/tmp/workspace", {});

		expect(opts.shouldAbort?.()).toBe(false);

		userKilledSet.add("ISSUE-1");
		expect(opts.shouldAbort?.()).toBe(true);

		userKilledSet.delete("ISSUE-1");
		expect(opts.shouldAbort?.()).toBe(false);

		userSkippedSet.add("ISSUE-1");
		expect(opts.shouldAbort?.()).toBe(true);

		userSkippedSet.delete("ISSUE-1");
	});
});
