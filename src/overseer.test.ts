import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STUCK_MESSAGE, getGitSnapshot, startOverseer } from "./overseer.js";
import type { OverseerConfig } from "./types.js";

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

		startOverseer(proc, "/any", makeConfig(), getSnapshot);

		// Advance well past the threshold — first kill should clear the timer
		await vi.advanceTimersByTimeAsync(10_000);

		expect(proc.killCalls.length).toBeLessThanOrEqual(1);
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
