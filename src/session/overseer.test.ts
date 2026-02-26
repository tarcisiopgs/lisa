import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OverseerConfig } from "../types/index.js";
import { kanbanEmitter } from "../ui/state.js";
import {
	createErrorLoopDetector,
	getGitSnapshot,
	STUCK_MESSAGE,
	startOverseer,
} from "./overseer.js";

// ── helpers ────────────────────────────────────────────────────────────────

function makeMockProc(): ChildProcess & { killCalls: string[] } {
	const killCalls: string[] = [];
	const proc = {
		killCalls,
		kill(signal?: string) {
			killCalls.push(signal ?? "SIGTERM");
		},
	} as unknown as ChildProcess & { killCalls: string[] };
	return proc;
}

function makeConfig(overrides: Partial<OverseerConfig> = {}): OverseerConfig {
	return {
		enabled: true,
		check_interval: 1,
		stuck_threshold: 3,
		...overrides,
	};
}

// ── STUCK_MESSAGE ──────────────────────────────────────────────────────────

describe("STUCK_MESSAGE", () => {
	it("contains the lisa-overseer marker for fallback detection", () => {
		expect(STUCK_MESSAGE).toMatch(/lisa-overseer/i);
	});

	it("mentions no git changes", () => {
		expect(STUCK_MESSAGE.toLowerCase()).toContain("no git changes");
	});
});

// ── getGitSnapshot ─────────────────────────────────────────────────────────

describe("getGitSnapshot", () => {
	it("returns a string for a valid git repo", async () => {
		// Run in the current repo root — always a git dir
		const snapshot = await getGitSnapshot(process.cwd());
		expect(typeof snapshot).toBe("string");
	});

	it("returns empty string for a non-git directory", async () => {
		const snapshot = await getGitSnapshot("/tmp");
		expect(snapshot).toBe("");
	});
});

// ── startOverseer — disabled ───────────────────────────────────────────────

describe("startOverseer (disabled)", () => {
	it("returns a no-op handle when enabled is false", () => {
		const proc = makeMockProc();
		const handle = startOverseer(proc, "/tmp", makeConfig({ enabled: false }));

		handle.stop();
		expect(handle.wasKilled()).toBe(false);
		expect(proc.killCalls).toHaveLength(0);
	});
});

// ── startOverseer — enabled, fake timers ──────────────────────────────────

describe("startOverseer (enabled)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		kanbanEmitter.removeAllListeners("loop:pause-provider");
		kanbanEmitter.removeAllListeners("loop:resume-provider");
	});

	it("does not kill when snapshot changes between checks", async () => {
		const proc = makeMockProc();
		let callCount = 0;
		const getSnapshot = vi.fn(async () => {
			callCount++;
			return `snapshot-${callCount}`;
		});

		const handle = startOverseer(proc, "/any", makeConfig(), getSnapshot);

		// First check → baseline
		await vi.advanceTimersByTimeAsync(1000);
		// Second check → new snapshot → progress
		await vi.advanceTimersByTimeAsync(1000);
		// Third check → another new snapshot → still progress
		await vi.advanceTimersByTimeAsync(1000);

		handle.stop();
		expect(handle.wasKilled()).toBe(false);
		expect(proc.killCalls).toHaveLength(0);
	});

	it("kills the process when stuck threshold is exceeded", async () => {
		const proc = makeMockProc();
		// Always returns the same snapshot → no progress
		const getSnapshot = vi.fn(async () => "same-snapshot");

		const handle = startOverseer(proc, "/any", makeConfig(), getSnapshot);

		// First check: establish baseline, start idle timer
		await vi.advanceTimersByTimeAsync(1000);
		// Second check: same snapshot, idle = 1s < 3s
		await vi.advanceTimersByTimeAsync(1000);
		// Third check: same snapshot, idle = 2s < 3s
		await vi.advanceTimersByTimeAsync(1000);
		// Fourth check: same snapshot, idle ≥ 3s → kill
		await vi.advanceTimersByTimeAsync(1000);

		expect(handle.wasKilled()).toBe(true);
		expect(proc.killCalls).toContain("SIGTERM");

		handle.stop(); // should be no-op since already killed
	});

	it("resets idle timer when snapshot changes after initial idle", async () => {
		const proc = makeMockProc();
		let call = 0;
		const getSnapshot = vi.fn(async () => {
			call++;
			// Snapshot changes at call 3 — prevents kill
			if (call <= 2) return "same";
			return `new-${call}`;
		});

		const handle = startOverseer(proc, "/any", makeConfig(), getSnapshot);

		// call 1 → baseline "same", idle timer starts
		await vi.advanceTimersByTimeAsync(1000);
		// call 2 → "same", idle = 1s < 3s
		await vi.advanceTimersByTimeAsync(1000);
		// call 3 → "new-3", progress! idle timer resets
		await vi.advanceTimersByTimeAsync(1000);
		// call 4 → "new-4", still progress → no kill
		await vi.advanceTimersByTimeAsync(1000);

		handle.stop();
		expect(handle.wasKilled()).toBe(false);
		expect(proc.killCalls).toHaveLength(0);
	});

	it("stop() prevents the kill from firing", async () => {
		const proc = makeMockProc();
		const getSnapshot = vi.fn(async () => "same-snapshot");

		const handle = startOverseer(proc, "/any", makeConfig(), getSnapshot);

		// First check: baseline
		await vi.advanceTimersByTimeAsync(1000);
		// Stop before threshold is reached
		handle.stop();

		// Advance well past the threshold — should not kill because stopped
		await vi.advanceTimersByTimeAsync(10_000);

		expect(handle.wasKilled()).toBe(false);
		expect(proc.killCalls).toHaveLength(0);
	});

	it("kills only once even if timer fires again before proc exits", async () => {
		const proc = makeMockProc();
		const getSnapshot = vi.fn(async () => "same");

		const handle = startOverseer(proc, "/any", makeConfig(), getSnapshot);

		// Advance well past the threshold — first kill should clear the timer
		await vi.advanceTimersByTimeAsync(10_000);

		expect(proc.killCalls.length).toBeLessThanOrEqual(1);

		handle.stop();
	});

	it("swallows errors from getSnapshot without killing", async () => {
		const proc = makeMockProc();
		const getSnapshot = vi.fn(async () => {
			throw new Error("git failure");
		});

		const handle = startOverseer(proc, "/any", makeConfig(), getSnapshot);

		// Advance well past stuck_threshold — errors should not trigger kill
		await vi.advanceTimersByTimeAsync(10_000);

		handle.stop();
		expect(handle.wasKilled()).toBe(false);
		expect(proc.killCalls).toHaveLength(0);
	});
});

// ── startOverseer — pause/resume via kanbanEmitter ────────────────────────

describe("startOverseer (pause/resume)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		kanbanEmitter.removeAllListeners("loop:pause-provider");
		kanbanEmitter.removeAllListeners("loop:resume-provider");
	});

	it("does not kill while paused even if stuck threshold is exceeded", async () => {
		const proc = makeMockProc();
		const getSnapshot = vi.fn(async () => "same-snapshot");

		const handle = startOverseer(proc, "/any", makeConfig(), getSnapshot);

		// First check: baseline
		await vi.advanceTimersByTimeAsync(1000);

		// Pause the provider
		kanbanEmitter.emit("loop:pause-provider");

		// Advance well past the threshold while paused
		await vi.advanceTimersByTimeAsync(10_000);

		expect(handle.wasKilled()).toBe(false);
		expect(proc.killCalls).toHaveLength(0);

		handle.stop();
	});

	it("resets idle timer on resume so paused time is not counted as stuck", async () => {
		const proc = makeMockProc();
		const getSnapshot = vi.fn(async () => "same-snapshot");

		const handle = startOverseer(proc, "/any", makeConfig(), getSnapshot);

		// First check: baseline
		await vi.advanceTimersByTimeAsync(1000);
		// Second check: idle = 1s
		await vi.advanceTimersByTimeAsync(1000);

		// Pause the provider (idle = 2s at this point, threshold = 3s)
		kanbanEmitter.emit("loop:pause-provider");
		// Advance time while paused
		await vi.advanceTimersByTimeAsync(5000);

		// Resume — idle timer should reset
		kanbanEmitter.emit("loop:resume-provider");

		// Advance 2s after resume — total idle since resume = 2s < 3s threshold
		await vi.advanceTimersByTimeAsync(2000);

		expect(handle.wasKilled()).toBe(false);
		expect(proc.killCalls).toHaveLength(0);

		handle.stop();
	});

	it("can be paused and resumed multiple times", async () => {
		const proc = makeMockProc();
		const getSnapshot = vi.fn(async () => "same-snapshot");

		const handle = startOverseer(proc, "/any", makeConfig(), getSnapshot);

		// First check: baseline
		await vi.advanceTimersByTimeAsync(1000);

		// Pause, advance, resume
		kanbanEmitter.emit("loop:pause-provider");
		await vi.advanceTimersByTimeAsync(3000);
		kanbanEmitter.emit("loop:resume-provider");

		// Advance 2s (within threshold)
		await vi.advanceTimersByTimeAsync(2000);

		// Pause again, advance past threshold
		kanbanEmitter.emit("loop:pause-provider");
		await vi.advanceTimersByTimeAsync(10_000);

		expect(handle.wasKilled()).toBe(false);
		expect(proc.killCalls).toHaveLength(0);

		handle.stop();
	});

	it("stop() cleans up kanbanEmitter listeners", () => {
		const proc = makeMockProc();
		const getSnapshot = vi.fn(async () => "same-snapshot");

		const beforePause = kanbanEmitter.listenerCount("loop:pause-provider");
		const beforeResume = kanbanEmitter.listenerCount("loop:resume-provider");

		const handle = startOverseer(proc, "/any", makeConfig(), getSnapshot);

		expect(kanbanEmitter.listenerCount("loop:pause-provider")).toBe(beforePause + 1);
		expect(kanbanEmitter.listenerCount("loop:resume-provider")).toBe(beforeResume + 1);

		handle.stop();

		expect(kanbanEmitter.listenerCount("loop:pause-provider")).toBe(beforePause);
		expect(kanbanEmitter.listenerCount("loop:resume-provider")).toBe(beforeResume);
	});
});

// ── createErrorLoopDetector ────────────────────────────────────────────────

describe("createErrorLoopDetector", () => {
	it("does not kill before threshold is reached", () => {
		const proc = makeMockProc();
		const detector = createErrorLoopDetector(proc, /^Error /, 5);

		detector.check("Error line one\nError line two\nError line three\n");

		expect(detector.wasKilled()).toBe(false);
		expect(proc.killCalls).toHaveLength(0);
	});

	it("kills the process when consecutive error lines reach the threshold", () => {
		const proc = makeMockProc();
		const detector = createErrorLoopDetector(proc, /^Error /, 3);

		detector.check("Error one\nError two\nError three\n");

		expect(detector.wasKilled()).toBe(true);
		expect(proc.killCalls).toContain("SIGTERM");
	});

	it("resets the counter when a non-error line appears", () => {
		const proc = makeMockProc();
		const detector = createErrorLoopDetector(proc, /^Error /, 3);

		detector.check("Error one\nError two\nDoing something useful\nError one\n");

		expect(detector.wasKilled()).toBe(false);
		expect(proc.killCalls).toHaveLength(0);
	});

	it("accumulates count across multiple check() calls", () => {
		const proc = makeMockProc();
		const detector = createErrorLoopDetector(proc, /^Error /, 3);

		detector.check("Error one\n");
		detector.check("Error two\n");
		detector.check("Error three\n");

		expect(detector.wasKilled()).toBe(true);
		expect(proc.killCalls).toContain("SIGTERM");
	});

	it("ignores blank lines when counting consecutive errors", () => {
		const proc = makeMockProc();
		const detector = createErrorLoopDetector(proc, /^Error /, 3);

		detector.check("Error one\n\nError two\n\n\nError three\n");

		expect(detector.wasKilled()).toBe(true);
	});

	it("does not kill again after already killed", () => {
		const proc = makeMockProc();
		const detector = createErrorLoopDetector(proc, /^Error /, 2);

		detector.check("Error one\nError two\n");
		expect(detector.wasKilled()).toBe(true);
		const killsBefore = proc.killCalls.length;

		// Further calls should be no-ops
		detector.check("Error three\nError four\n");
		expect(proc.killCalls.length).toBe(killsBefore);
	});

	it("uses default threshold of 25 when not specified", () => {
		const proc = makeMockProc();
		const detector = createErrorLoopDetector(proc, /^Error /);

		// 24 errors — should not kill
		detector.check(Array.from({ length: 24 }, (_, i) => `Error line ${i}`).join("\n"));
		expect(detector.wasKilled()).toBe(false);

		// 25th error — should kill
		detector.check("Error line 25\n");
		expect(detector.wasKilled()).toBe(true);
	});

	it("works with Gemini-specific pattern", () => {
		const proc = makeMockProc();
		const detector = createErrorLoopDetector(proc, /^Error (executing tool|generating content)/, 3);

		// These should count
		detector.check(
			"Error executing tool replace: not found\nError executing tool write_file: missing param\nError generating content via API\n",
		);

		expect(detector.wasKilled()).toBe(true);
	});

	it("does not count lines that do not match the pattern", () => {
		const proc = makeMockProc();
		const detector = createErrorLoopDetector(proc, /^Error /, 3);

		// "error" lowercase, "WARNING:", "FAIL" — none start with "Error "
		detector.check("error: lowercase\nWARNING: something\nFAIL: build\n");

		expect(detector.wasKilled()).toBe(false);
	});
});
