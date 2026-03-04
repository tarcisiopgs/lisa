import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Provider } from "../types/index.js";
import { CodexProvider } from "./codex.js";
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

describe("CodexProvider", () => {
	beforeEach(() => {
		vi.mocked(spawnWithPty).mockImplementation(() => makeFakeProc() as never);
	});

	afterEach(() => {
		vi.resetAllMocks();
	});

	it("has name codex", () => {
		expect(new CodexProvider().name).toBe("codex");
	});

	it("does not support native worktree", () => {
		const provider: Provider = new CodexProvider();
		expect(provider.supportsNativeWorktree).toBeFalsy();
	});

	describe("isAvailable", () => {
		it("returns true when codex binary is found", async () => {
			const { execSync } = await import("node:child_process");
			vi.mocked(execSync).mockReturnValue(Buffer.from(""));
			expect(await new CodexProvider().isAvailable()).toBe(true);
			expect(vi.mocked(execSync)).toHaveBeenCalledWith("which codex", expect.anything());
		});

		it("returns false when codex binary is not found", async () => {
			const { execSync } = await import("node:child_process");
			vi.mocked(execSync).mockImplementation(() => {
				throw new Error("command not found");
			});
			expect(await new CodexProvider().isAvailable()).toBe(false);
		});
	});

	describe("run", () => {
		it("returns success=true on exit code 0", async () => {
			const result = await new CodexProvider().run("do something", {
				cwd: "/tmp",
				logFile: "/tmp/test.log",
				env: {},
			});
			expect(result.success).toBe(true);
		});

		it("returns success=false on non-zero exit code", async () => {
			vi.mocked(spawnWithPty).mockImplementation(() => makeFakeProc(1) as never);

			const result = await new CodexProvider().run("do something", {
				cwd: "/tmp",
				logFile: "/tmp/test.log",
				env: {},
			});
			expect(result.success).toBe(false);
		});

		it("includes dangerously-bypass-approvals-and-sandbox in command", async () => {
			await new CodexProvider().run("do something", {
				cwd: "/tmp",
				logFile: "/tmp/test.log",
				env: {},
			});

			const command = vi.mocked(spawnWithPty).mock.calls[0]![0] as string;
			expect(command).toContain("--dangerously-bypass-approvals-and-sandbox");
			expect(command).toContain("--ephemeral");
		});

		it("includes --model flag when model is specified", async () => {
			await new CodexProvider().run("do something", {
				cwd: "/tmp",
				logFile: "/tmp/test.log",
				env: {},
				model: "o4-mini",
			});

			const command = vi.mocked(spawnWithPty).mock.calls[0]![0] as string;
			expect(command).toContain("--model o4-mini");
		});

		it("omits --model flag when no model specified", async () => {
			await new CodexProvider().run("do something", {
				cwd: "/tmp",
				logFile: "/tmp/test.log",
				env: {},
			});

			const command = vi.mocked(spawnWithPty).mock.calls[0]![0] as string;
			expect(command).not.toContain("--model");
		});
	});
});
