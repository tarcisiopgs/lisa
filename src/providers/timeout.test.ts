import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionTimeout, TIMEOUT_MESSAGE } from "./timeout.js";

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

describe("TIMEOUT_MESSAGE", () => {
	it("contains the lisa-timeout marker for fallback detection", () => {
		expect(TIMEOUT_MESSAGE).toMatch(/lisa-timeout/i);
	});

	it("mentions session_timeout", () => {
		expect(TIMEOUT_MESSAGE.toLowerCase()).toContain("session_timeout");
	});
});

describe("createSessionTimeout", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns a no-op handle when timeoutSeconds is 0", () => {
		const proc = makeMockProc();
		const handle = createSessionTimeout(proc, 0);

		handle.stop();
		expect(handle.wasTimedOut()).toBe(false);
		expect(proc.killCalls).toHaveLength(0);
	});

	it("returns a no-op handle when timeoutSeconds is undefined", () => {
		const proc = makeMockProc();
		const handle = createSessionTimeout(proc, undefined);

		handle.stop();
		expect(handle.wasTimedOut()).toBe(false);
		expect(proc.killCalls).toHaveLength(0);
	});

	it("kills the process after the timeout elapses", async () => {
		const proc = makeMockProc();
		const handle = createSessionTimeout(proc, 5);

		await vi.advanceTimersByTimeAsync(4999);
		expect(handle.wasTimedOut()).toBe(false);
		expect(proc.killCalls).toHaveLength(0);

		await vi.advanceTimersByTimeAsync(1);
		expect(handle.wasTimedOut()).toBe(true);
		expect(proc.killCalls).toContain("SIGTERM");
	});

	it("stop() prevents the kill from firing", async () => {
		const proc = makeMockProc();
		const handle = createSessionTimeout(proc, 5);

		await vi.advanceTimersByTimeAsync(3000);
		handle.stop();

		await vi.advanceTimersByTimeAsync(10000);
		expect(handle.wasTimedOut()).toBe(false);
		expect(proc.killCalls).toHaveLength(0);
	});

	it("does not create a timeout for negative values", () => {
		const proc = makeMockProc();
		const handle = createSessionTimeout(proc, -1);

		expect(handle.wasTimedOut()).toBe(false);
		handle.stop();
	});
});
