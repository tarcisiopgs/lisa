import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Provider } from "../types/index.js";
import { OpenCodeProvider } from "./opencode.js";
import { spawnWithPty } from "./pty.js";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, execSync: vi.fn() };
});

vi.mock("./pty.js", () => ({
	spawnWithPty: vi.fn(),
	stripAnsi: (s: string) => s,
}));

function makeFakeProc(exitCode = 0) {
	const proc = Object.assign(new EventEmitter(), {
		stdout: new EventEmitter(),
		stderr: new EventEmitter(),
		pid: 12345,
		kill: vi.fn(),
	});
	setImmediate(() => proc.emit("close", exitCode));
	return { proc, isPty: false as const };
}

describe("OpenCodeProvider", () => {
	beforeEach(() => {
		vi.mocked(spawnWithPty).mockImplementation(() => makeFakeProc() as never);
	});

	afterEach(() => {
		vi.resetAllMocks();
	});

	it("has name opencode", () => {
		expect(new OpenCodeProvider().name).toBe("opencode");
	});

	it("does not support native worktree", () => {
		const provider: Provider = new OpenCodeProvider();
		expect(provider.supportsNativeWorktree).toBeFalsy();
	});

	describe("isAvailable", () => {
		it("returns true when opencode binary is found", async () => {
			const { execSync } = await import("node:child_process");
			vi.mocked(execSync).mockReturnValue(Buffer.from(""));
			expect(await new OpenCodeProvider().isAvailable()).toBe(true);
		});

		it("returns false when opencode binary is not found", async () => {
			const { execSync } = await import("node:child_process");
			vi.mocked(execSync).mockImplementation(() => {
				throw new Error("command not found");
			});
			expect(await new OpenCodeProvider().isAvailable()).toBe(false);
		});
	});

	describe("run", () => {
		it("returns success=true on exit code 0", async () => {
			const result = await new OpenCodeProvider().run("do something", {
				cwd: "/tmp",
				logFile: "/tmp/test.log",
				env: {},
			});
			expect(result.success).toBe(true);
		});

		it("returns success=false on non-zero exit code", async () => {
			vi.mocked(spawnWithPty).mockImplementation(() => makeFakeProc(1) as never);

			const result = await new OpenCodeProvider().run("do something", {
				cwd: "/tmp",
				logFile: "/tmp/test.log",
				env: {},
			});
			expect(result.success).toBe(false);
		});

		it("passes cwd with spaces correctly to spawnWithPty (I-07)", async () => {
			const cwdWithSpaces = "/Users/John Doe/my project";

			await new OpenCodeProvider().run("do something", {
				cwd: cwdWithSpaces,
				logFile: "/tmp/test.log",
				env: {},
			});

			const spawnOpts = vi.mocked(spawnWithPty).mock.calls[0]![1] as { cwd: string };
			expect(spawnOpts.cwd).toBe(cwdWithSpaces);
		});
	});
});
