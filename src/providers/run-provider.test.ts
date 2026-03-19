import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
	execFile: vi.fn(),
	spawn: vi.fn(),
}));

import { execFile } from "node:child_process";
import { isCommandAvailable, resetAvailabilityCache } from "./run-provider.js";

function mockExecFileSuccess() {
	vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
		const cb = args[args.length - 1] as (err: Error | null, stdout: string, stderr: string) => void;
		cb(null, "v1.0.0", "");
	}) as typeof execFile);
}

function mockExecFileFailure() {
	vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
		const cb = args[args.length - 1] as (err: Error | null) => void;
		cb(new Error("ENOENT"));
	}) as typeof execFile);
}

describe("isCommandAvailable", () => {
	beforeEach(() => {
		resetAvailabilityCache();
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns true when command exists", async () => {
		mockExecFileSuccess();
		const result = await isCommandAvailable("node");
		expect(result).toBe(true);
	});

	it("returns false when command doesn't exist", async () => {
		mockExecFileFailure();
		const result = await isCommandAvailable("nonexistent-command-xyz");
		expect(result).toBe(false);
	});

	it("caches results (second call doesn't invoke execFile again)", async () => {
		mockExecFileSuccess();

		await isCommandAvailable("cached-cmd");
		await isCommandAvailable("cached-cmd");

		expect(execFile).toHaveBeenCalledTimes(1);
	});

	it("resetAvailabilityCache clears the cache", async () => {
		mockExecFileSuccess();

		await isCommandAvailable("reset-cmd");
		expect(execFile).toHaveBeenCalledTimes(1);

		resetAvailabilityCache();
		await isCommandAvailable("reset-cmd");
		expect(execFile).toHaveBeenCalledTimes(2);
	});
});
