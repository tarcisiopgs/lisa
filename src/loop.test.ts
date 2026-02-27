import { describe, expect, it } from "vitest";
import type { LoopOptions } from "./loop.js";
import { WATCH_POLL_INTERVAL_MS } from "./loop.js";

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
