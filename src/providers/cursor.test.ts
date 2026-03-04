import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Provider } from "../types/index.js";
import { CursorProvider } from "./cursor.js";
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

describe("CursorProvider", () => {
	beforeEach(() => {
		vi.mocked(spawnWithPty).mockImplementation(() => makeFakeProc() as never);
	});

	afterEach(() => {
		vi.resetAllMocks();
	});

	it("has name cursor", () => {
		expect(new CursorProvider().name).toBe("cursor");
	});

	it("does not support native worktree", () => {
		const provider: Provider = new CursorProvider();
		expect(provider.supportsNativeWorktree).toBeFalsy();
	});

	describe("isAvailable", () => {
		it("returns true when agent binary is found", async () => {
			const { execSync } = await import("node:child_process");
			vi.mocked(execSync).mockReturnValue(Buffer.from(""));
			expect(await new CursorProvider().isAvailable()).toBe(true);
		});

		it("returns false when neither agent nor cursor-agent is found", async () => {
			const { execSync } = await import("node:child_process");
			vi.mocked(execSync).mockImplementation(() => {
				throw new Error("command not found");
			});
			expect(await new CursorProvider().isAvailable()).toBe(false);
		});
	});

	describe("run", () => {
		it("returns success=true on exit code 0", async () => {
			const { execSync } = await import("node:child_process");
			vi.mocked(execSync).mockReturnValue(Buffer.from(""));

			const provider = new CursorProvider();
			const result = await provider.run("do something", {
				cwd: "/tmp",
				logFile: "/tmp/test.log",
				env: {},
			});

			expect(result.success).toBe(true);
		});

		it("returns success=false on non-zero exit code", async () => {
			const { execSync } = await import("node:child_process");
			vi.mocked(execSync).mockReturnValue(Buffer.from(""));
			vi.mocked(spawnWithPty).mockImplementation(() => makeFakeProc(1) as never);

			const provider = new CursorProvider();
			const result = await provider.run("do something", {
				cwd: "/tmp",
				logFile: "/tmp/test.log",
				env: {},
			});

			expect(result.success).toBe(false);
		});

		it("returns not-installed error immediately when binary not found", async () => {
			const { execSync } = await import("node:child_process");
			vi.mocked(execSync).mockImplementation(() => {
				throw new Error("command not found");
			});

			const provider = new CursorProvider();
			const result = await provider.run("do something", {
				cwd: "/tmp",
				logFile: "/tmp/test.log",
				env: {},
			});

			expect(result.success).toBe(false);
			expect(result.output).toContain("not installed or not in PATH");
			expect(vi.mocked(spawnWithPty)).not.toHaveBeenCalled();
		});

		it("resolves binary only once across isAvailable and run (U-07)", async () => {
			const { execSync } = await import("node:child_process");
			vi.mocked(execSync).mockReturnValue(Buffer.from(""));

			const provider = new CursorProvider();
			await provider.isAvailable();
			await provider.run("do something", {
				cwd: "/tmp",
				logFile: "/tmp/test.log",
				env: {},
			});

			// execSync called once for "agent --version" only, not again in run()
			expect(vi.mocked(execSync)).toHaveBeenCalledTimes(1);
		});

		it("includes --output-format text --force in command", async () => {
			const { execSync } = await import("node:child_process");
			vi.mocked(execSync).mockReturnValue(Buffer.from(""));

			const provider = new CursorProvider();
			await provider.run("do something", {
				cwd: "/tmp",
				logFile: "/tmp/test.log",
				env: {},
			});

			const command = vi.mocked(spawnWithPty).mock.calls[0]![0] as string;
			expect(command).toContain("--output-format text");
			expect(command).toContain("--force");
		});
	});
});
