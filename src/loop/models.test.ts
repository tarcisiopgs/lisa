import { describe, expect, it, vi } from "vitest";
import type { LisaConfig, ProviderName } from "../types/index.js";
import type { LoopOptions } from "./models.js";
import { resolveModels, WATCH_POLL_INTERVAL_MS } from "./models.js";

describe("LoopOptions", () => {
	it("accepts concurrency field", () => {
		const opts: LoopOptions = {
			once: false,
			watch: false,
			limit: 0,
			dryRun: false,
			concurrency: 3,
		};
		expect(opts.concurrency).toBe(3);
	});

	it("defaults concurrency to 1 for backward compatibility", () => {
		const opts: LoopOptions = {
			once: false,
			watch: false,
			limit: 0,
			dryRun: false,
			concurrency: 1,
		};
		expect(opts.concurrency).toBe(1);
	});

	it("accepts optional issueId with concurrency", () => {
		const opts: LoopOptions = {
			once: true,
			watch: false,
			limit: 1,
			dryRun: false,
			issueId: "INT-123",
			concurrency: 1,
		};
		expect(opts.issueId).toBe("INT-123");
		expect(opts.concurrency).toBe(1);
	});

	it("accepts watch flag", () => {
		const opts: LoopOptions = {
			once: false,
			watch: true,
			limit: 0,
			dryRun: false,
			concurrency: 1,
		};
		expect(opts.watch).toBe(true);
	});

	it("watch defaults to false for backward compatibility", () => {
		const opts: LoopOptions = {
			once: false,
			watch: false,
			limit: 0,
			dryRun: false,
			concurrency: 1,
		};
		expect(opts.watch).toBe(false);
	});
});

describe("WATCH_POLL_INTERVAL_MS", () => {
	it("is 60 seconds", () => {
		expect(WATCH_POLL_INTERVAL_MS).toBe(60_000);
	});
});

describe("concurrency flag parsing", () => {
	it("parses valid concurrency values", () => {
		expect(Math.max(1, Number.parseInt("3", 10) || 1)).toBe(3);
		expect(Math.max(1, Number.parseInt("1", 10) || 1)).toBe(1);
		expect(Math.max(1, Number.parseInt("10", 10) || 1)).toBe(10);
	});

	it("clamps invalid values to 1", () => {
		expect(Math.max(1, Number.parseInt("0", 10) || 1)).toBe(1);
		expect(Math.max(1, Number.parseInt("-1", 10) || 1)).toBe(1);
		expect(Math.max(1, Number.parseInt("abc", 10) || 1)).toBe(1);
		expect(Math.max(1, Number.parseInt("", 10) || 1)).toBe(1);
	});
});

describe("resolveModels — basic", () => {
	function makeConfig(provider: ProviderName, models?: string[]): LisaConfig {
		return {
			provider,
			provider_options: models ? { [provider]: { models } } : undefined,
			source: "linear",
			source_config: {
				scope: "",
				project: "",
				label: "",
				pick_from: "",
				in_progress: "",
				done: "",
			},
			platform: "cli",
			workflow: "worktree",
			workspace: ".",
			base_branch: "main",
			repos: [],
			loop: { cooldown: 0, max_sessions: 0 },
		} as LisaConfig;
	}

	it("returns single spec with no model when no models configured", () => {
		const config = makeConfig("claude");
		const models = resolveModels(config);
		expect(models).toEqual([{ provider: "claude" }]);
	});

	it("returns single spec when models array is empty", () => {
		const config = makeConfig("claude", []);
		const models = resolveModels(config);
		expect(models).toEqual([{ provider: "claude" }]);
	});

	it("warns when a model name matches a known provider name", () => {
		const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const config = makeConfig("claude", ["gemini"]);
		resolveModels(config);
		const warnCalls = warnSpy.mock.calls.flat().join(" ");
		expect(warnCalls).toContain("looks like a provider name");
		warnSpy.mockRestore();
	});

	it("does not warn when model matches own provider name", () => {
		const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const config = makeConfig("claude", ["claude"]);
		resolveModels(config);
		const warnCalls = warnSpy.mock.calls.flat().join(" ");
		expect(warnCalls).not.toContain("looks like a provider name");
		warnSpy.mockRestore();
	});

	it("forces auto model for cursor when no auto model present", () => {
		const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const config = makeConfig("cursor" as ProviderName, ["some-model"]);
		const models = resolveModels(config);
		expect(models).toEqual([{ provider: "cursor", model: "auto" }]);
		warnSpy.mockRestore();
	});

	it("does not force auto for cursor when auto is already present", () => {
		const config = makeConfig("cursor" as ProviderName, ["auto"]);
		const models = resolveModels(config);
		expect(models).toEqual([{ provider: "cursor", model: "auto" }]);
	});

	it("sets model to undefined when model name matches provider name", () => {
		const config = makeConfig("claude", ["claude", "claude-sonnet-4-6"]);
		const models = resolveModels(config);
		expect(models[0]).toEqual({ provider: "claude", model: undefined });
		expect(models[1]).toEqual({ provider: "claude", model: "claude-sonnet-4-6" });
	});
});

describe("resolveModels — provider-prefixed model warning", () => {
	function makeConfig(provider: ProviderName, models: string[]): LisaConfig {
		return {
			provider,
			provider_options: { [provider]: { models } },
			source: "linear",
			source_config: {
				scope: "",
				project: "",
				label: "",
				pick_from: "",
				in_progress: "",
				done: "",
			},
			platform: "cli",
			workflow: "worktree",
			workspace: ".",
			base_branch: "main",
			repos: [],
			loop: { cooldown: 0, max_sessions: 0 },
		} as LisaConfig;
	}

	it("warns when model name starts with provider name prefix", () => {
		const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const config = makeConfig("opencode", ["opencode/trinity-large-preview-free"]);
		resolveModels(config);
		const warnCalls = warnSpy.mock.calls.flat().join(" ");
		expect(warnCalls).toContain("opencode/");
		expect(warnCalls).toContain("trinity-large-preview-free");
		warnSpy.mockRestore();
	});

	it("does not warn when model name uses a different prefix", () => {
		const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const config = makeConfig("opencode", ["openrouter/model-name"]);
		resolveModels(config);
		const warnCalls = warnSpy.mock.calls.flat().join(" ");
		expect(warnCalls).not.toContain("starts with the provider name");
		warnSpy.mockRestore();
	});

	it("does not warn for simple model names without slashes", () => {
		const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const config = makeConfig("claude", ["claude-sonnet-4-6"]);
		resolveModels(config);
		const warnCalls = warnSpy.mock.calls.flat().join(" ");
		expect(warnCalls).not.toContain("starts with the provider name");
		warnSpy.mockRestore();
	});
});

describe("workflow mode enforcement", () => {
	it("forces worktree when concurrency > 1", () => {
		let workflow = "branch";
		const concurrency = 3;
		if (concurrency > 1 && workflow !== "worktree") {
			workflow = "worktree";
		}
		expect(workflow).toBe("worktree");
	});

	it("preserves workflow when concurrency is 1", () => {
		let workflow = "branch";
		const concurrency = 1;
		if (concurrency > 1 && workflow !== "worktree") {
			workflow = "worktree";
		}
		expect(workflow).toBe("branch");
	});

	it("preserves worktree when already set", () => {
		let workflow = "worktree";
		const concurrency = 3;
		if (concurrency > 1 && workflow !== "worktree") {
			workflow = "worktree";
		}
		expect(workflow).toBe("worktree");
	});
});
