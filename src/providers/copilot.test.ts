import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Provider } from "../types/index.js";
import { CopilotProvider } from "./copilot.js";
import { spawnWithPty } from "./pty.js";
import { isCommandAvailable } from "./run-provider.js";

vi.mock("./pty.js", () => ({
	spawnWithPty: vi.fn(),
	stripAnsi: (s: string) => s,
}));

vi.mock("./run-provider.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./run-provider.js")>();
	return { ...actual, isCommandAvailable: vi.fn() };
});

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

describe("CopilotProvider", () => {
	beforeEach(() => {
		vi.mocked(spawnWithPty).mockImplementation(() => makeFakeProc() as never);
	});

	afterEach(() => {
		vi.resetAllMocks();
	});

	it("has name copilot", () => {
		expect(new CopilotProvider().name).toBe("copilot");
	});

	it("does not support native worktree", () => {
		const provider: Provider = new CopilotProvider();
		expect(provider.supportsNativeWorktree).toBeFalsy();
	});

	describe("isAvailable", () => {
		it("returns true when copilot binary is found", async () => {
			vi.mocked(isCommandAvailable).mockResolvedValue(true);
			expect(await new CopilotProvider().isAvailable()).toBe(true);
			expect(vi.mocked(isCommandAvailable)).toHaveBeenCalledWith("copilot", ["version"]);
		});

		it("returns false when copilot binary is not found", async () => {
			vi.mocked(isCommandAvailable).mockResolvedValue(false);
			expect(await new CopilotProvider().isAvailable()).toBe(false);
		});
	});

	describe("run", () => {
		it("returns success=true on exit code 0", async () => {
			const result = await new CopilotProvider().run("do something", {
				cwd: "/tmp",
				logFile: "/tmp/test.log",
				env: {},
			});
			expect(result.success).toBe(true);
		});

		it("returns success=false on non-zero exit code", async () => {
			vi.mocked(spawnWithPty).mockImplementation(() => makeFakeProc(1) as never);

			const result = await new CopilotProvider().run("do something", {
				cwd: "/tmp",
				logFile: "/tmp/test.log",
				env: {},
			});
			expect(result.success).toBe(false);
		});

		it("includes --allow-all flag in command", async () => {
			await new CopilotProvider().run("do something", {
				cwd: "/tmp",
				logFile: "/tmp/test.log",
				env: {},
			});

			const command = vi.mocked(spawnWithPty).mock.calls[0]![0] as string;
			expect(command).toContain("--allow-all");
		});
	});
});
