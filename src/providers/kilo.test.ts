import { afterEach, describe, expect, it, vi } from "vitest";
import type { Provider, RunResult } from "../types/index.js";
import { KiloProvider } from "./kilo.js";
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

describe("KiloProvider", () => {
	afterEach(() => {
		vi.resetAllMocks();
	});

	it("has name kilo", () => {
		expect(new KiloProvider().name).toBe("kilo");
	});

	it("does not support native worktree", () => {
		const provider: Provider = new KiloProvider();
		expect(provider.supportsNativeWorktree).toBeFalsy();
	});

	describe("isAvailable", () => {
		it("returns true when kilo binary is found", async () => {
			vi.mocked(isCommandAvailable).mockResolvedValue(true);
			expect(await new KiloProvider().isAvailable()).toBe(true);
			expect(vi.mocked(isCommandAvailable)).toHaveBeenCalledWith("kilo");
		});

		it("returns false when kilo binary is not found", async () => {
			vi.mocked(isCommandAvailable).mockResolvedValue(false);
			expect(await new KiloProvider().isAvailable()).toBe(false);
		});
	});

	describe("run", () => {
		it("returns success=true on exit code 0", async () => {
			mockRunProvider.mockResolvedValue(mockSuccess());
			const result = await new KiloProvider().run("do something", {
				cwd: "/tmp",
				logFile: "/tmp/test.log",
				env: {},
			});
			expect(result.success).toBe(true);
		});

		it("returns success=false on non-zero exit code", async () => {
			mockRunProvider.mockResolvedValue(mockFailure());
			const result = await new KiloProvider().run("do something", {
				cwd: "/tmp",
				logFile: "/tmp/test.log",
				env: {},
			});
			expect(result.success).toBe(false);
		});

		it("includes --auto flag in command", async () => {
			mockRunProvider.mockResolvedValue(mockSuccess());
			await new KiloProvider().run("do something", {
				cwd: "/tmp",
				logFile: "/tmp/test.log",
				env: {},
			});

			const config = mockRunProvider.mock.calls[0]![0];
			expect(config.logLine).toContain("--auto");
		});

		it("uses kilo run in command", async () => {
			mockRunProvider.mockResolvedValue(mockSuccess());
			await new KiloProvider().run("do something", {
				cwd: "/tmp",
				logFile: "/tmp/test.log",
				env: {},
			});

			const config = mockRunProvider.mock.calls[0]![0];
			expect(config.logLine).toContain("kilo run");
		});

		it("returns failure result when run throws", async () => {
			mockRunProvider.mockRejectedValue(new Error("spawn failed"));
			const result = await new KiloProvider().run("do something", {
				cwd: "/tmp",
				logFile: "/tmp/test.log",
				env: {},
			});
			expect(result.success).toBe(false);
			expect(result.output).toBe("spawn failed");
		});
	});
});
