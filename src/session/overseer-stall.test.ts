import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOutputStallDetector, STALL_MESSAGE } from "./overseer.js";

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

describe("STALL_MESSAGE", () => {
	it("contains the lisa-stall marker for fallback detection", () => {
		expect(STALL_MESSAGE).toMatch(/lisa-stall/i);
	});
});

describe("createOutputStallDetector", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns a no-op handle when timeout is 0", () => {
		const proc = makeMockProc();
		const handle = createOutputStallDetector(proc, 0);

		handle.stop();
		expect(handle.wasKilled()).toBe(false);
		expect(proc.killCalls).toHaveLength(0);
	});

	it("uses default timeout (120s) when undefined", async () => {
		const proc = makeMockProc();
		const handle = createOutputStallDetector(proc, undefined);

		await vi.advanceTimersByTimeAsync(119_999);
		expect(handle.wasKilled()).toBe(false);

		await vi.advanceTimersByTimeAsync(1);
		expect(handle.wasKilled()).toBe(true);
		expect(proc.killCalls).toContain("SIGTERM");

		handle.stop();
	});

	it("kills the process after the stall timeout elapses", async () => {
		const proc = makeMockProc();
		const handle = createOutputStallDetector(proc, 5);

		await vi.advanceTimersByTimeAsync(4999);
		expect(handle.wasKilled()).toBe(false);
		expect(proc.killCalls).toHaveLength(0);

		await vi.advanceTimersByTimeAsync(1);
		expect(handle.wasKilled()).toBe(true);
		expect(proc.killCalls).toContain("SIGTERM");

		handle.stop();
	});

	it("reset() restarts the countdown", async () => {
		const proc = makeMockProc();
		const handle = createOutputStallDetector(proc, 5);

		// Advance 4s, then reset
		await vi.advanceTimersByTimeAsync(4000);
		handle.reset();

		// Advance another 4s — should NOT kill (reset restarted the 5s timer)
		await vi.advanceTimersByTimeAsync(4000);
		expect(handle.wasKilled()).toBe(false);

		// Advance 1 more second — now 5s since last reset
		await vi.advanceTimersByTimeAsync(1000);
		expect(handle.wasKilled()).toBe(true);
		expect(proc.killCalls).toContain("SIGTERM");

		handle.stop();
	});

	it("stop() prevents the kill from firing", async () => {
		const proc = makeMockProc();
		const handle = createOutputStallDetector(proc, 5);

		await vi.advanceTimersByTimeAsync(3000);
		handle.stop();

		await vi.advanceTimersByTimeAsync(10000);
		expect(handle.wasKilled()).toBe(false);
		expect(proc.killCalls).toHaveLength(0);
	});

	it("reset() is a no-op after kill", async () => {
		const proc = makeMockProc();
		const handle = createOutputStallDetector(proc, 1);

		await vi.advanceTimersByTimeAsync(1000);
		expect(handle.wasKilled()).toBe(true);

		// reset after kill should not throw or restart
		handle.reset();
		expect(handle.wasKilled()).toBe(true);
		expect(proc.killCalls).toHaveLength(1);

		handle.stop();
	});

	it("does not create a timeout for negative values", () => {
		const proc = makeMockProc();
		const handle = createOutputStallDetector(proc, -1);

		expect(handle.wasKilled()).toBe(false);
		handle.stop();
	});
});
