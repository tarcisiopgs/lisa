import { afterEach, describe, expect, it, vi } from "vitest";
import type { Provider, RunResult } from "../types/index.js";
import { ClaudeProvider } from "./claude.js";
import { isCommandAvailable, runProviderProcess } from "./run-provider.js";

vi.mock("./run-provider.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./run-provider.js")>();
	return {
		...actual,
		isCommandAvailable: vi.fn(),
		runProviderProcess: vi.fn(),
	};
});

const mockRunProvider = vi.mocked(runProviderProcess);

function mockSuccess(): RunResult {
	return { success: true, output: "done", duration: 1000 };
}

function mockFailure(): RunResult {
	return { success: false, output: "error", duration: 500 };
}

describe("ClaudeProvider", () => {
	afterEach(() => {
		vi.resetAllMocks();
	});

	it("has name claude", () => {
		expect(new ClaudeProvider().name).toBe("claude");
	});

	it("does not support native worktree", () => {
		const provider: Provider = new ClaudeProvider();
		expect(provider.supportsNativeWorktree).toBe(false);
	});

	describe("isAvailable", () => {
		it("returns true when claude binary is found", async () => {
			vi.mocked(isCommandAvailable).mockResolvedValue(true);
			expect(await new ClaudeProvider().isAvailable()).toBe(true);
			expect(vi.mocked(isCommandAvailable)).toHaveBeenCalledWith("claude");
		});

		it("returns false when claude binary is not found", async () => {
			vi.mocked(isCommandAvailable).mockResolvedValue(false);
			expect(await new ClaudeProvider().isAvailable()).toBe(false);
		});
	});

	describe("run", () => {
		it("returns success=true on exit code 0", async () => {
			mockRunProvider.mockResolvedValue(mockSuccess());
			const result = await new ClaudeProvider().run("do something", {
				cwd: "/tmp",
				logFile: "/tmp/test.log",
				env: {},
			});
			expect(result.success).toBe(true);
		});

		it("returns success=false on non-zero exit code", async () => {
			mockRunProvider.mockResolvedValue(mockFailure());
			const result = await new ClaudeProvider().run("do something", {
				cwd: "/tmp",
				logFile: "/tmp/test.log",
				env: {},
			});
			expect(result.success).toBe(false);
		});

		it("passes config with -p and --dangerously-skip-permissions", async () => {
			mockRunProvider.mockResolvedValue(mockSuccess());
			await new ClaudeProvider().run("do something", {
				cwd: "/tmp",
				logFile: "/tmp/test.log",
				env: {},
			});

			const config = mockRunProvider.mock.calls[0]![0];
			expect(config.logLine).toContain("-p");
			expect(config.logLine).toContain("--dangerously-skip-permissions");
		});

		it("includes --model flag when model is specified", async () => {
			mockRunProvider.mockResolvedValue(mockSuccess());
			await new ClaudeProvider().run("do something", {
				cwd: "/tmp",
				logFile: "/tmp/test.log",
				env: {},
				model: "claude-sonnet-4-6",
			});

			const config = mockRunProvider.mock.calls[0]![0];
			expect(config.logLine).toContain("--model claude-sonnet-4-6");
		});

		it("omits --model flag when no model specified", async () => {
			mockRunProvider.mockResolvedValue(mockSuccess());
			await new ClaudeProvider().run("do something", {
				cwd: "/tmp",
				logFile: "/tmp/test.log",
				env: {},
			});

			const config = mockRunProvider.mock.calls[0]![0];
			expect(config.logLine).not.toContain("--model");
		});

		it("includes --effort flag when providerOptions.effort is set", async () => {
			mockRunProvider.mockResolvedValue(mockSuccess());
			await new ClaudeProvider().run("do something", {
				cwd: "/tmp",
				logFile: "/tmp/test.log",
				env: {},
				providerOptions: { effort: "low" },
			});

			const config = mockRunProvider.mock.calls[0]![0];
			expect(config.logLine).toContain("--effort low");
		});

		it("omits --effort flag when providerOptions.effort is not set", async () => {
			mockRunProvider.mockResolvedValue(mockSuccess());
			await new ClaudeProvider().run("do something", {
				cwd: "/tmp",
				logFile: "/tmp/test.log",
				env: {},
			});

			const config = mockRunProvider.mock.calls[0]![0];
			expect(config.logLine).not.toContain("--effort");
		});

		it("sets CLAUDECODE to undefined in extraEnv", async () => {
			mockRunProvider.mockResolvedValue(mockSuccess());
			await new ClaudeProvider().run("do something", {
				cwd: "/tmp",
				logFile: "/tmp/test.log",
				env: {},
			});

			const config = mockRunProvider.mock.calls[0]![0];
			expect(config.extraEnv).toEqual({ CLAUDECODE: undefined });
		});

		it("returns failure result when run throws", async () => {
			mockRunProvider.mockRejectedValue(new Error("spawn failed"));
			const result = await new ClaudeProvider().run("do something", {
				cwd: "/tmp",
				logFile: "/tmp/test.log",
				env: {},
			});
			expect(result.success).toBe(false);
			expect(result.output).toBe("spawn failed");
		});
	});
});
