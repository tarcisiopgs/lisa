import { afterEach, describe, expect, it, vi } from "vitest";
import type { Provider, RunResult } from "../types/index.js";
import { MimoProvider } from "./mimo.js";
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

const opts = { cwd: "/tmp", logFile: "/tmp/test.log", env: {} };

describe("MimoProvider", () => {
	afterEach(() => {
		vi.resetAllMocks();
	});

	it("has name mimo", () => {
		expect(new MimoProvider().name).toBe("mimo");
	});

	it("does not support native worktree", () => {
		const provider: Provider = new MimoProvider();
		expect(provider.supportsNativeWorktree).toBeFalsy();
	});

	describe("isAvailable", () => {
		it("returns true when mimo binary is found", async () => {
			vi.mocked(isCommandAvailable).mockResolvedValue(true);
			expect(await new MimoProvider().isAvailable()).toBe(true);
			expect(vi.mocked(isCommandAvailable)).toHaveBeenCalledWith("mimo");
		});

		it("returns false when mimo binary is not found", async () => {
			vi.mocked(isCommandAvailable).mockResolvedValue(false);
			expect(await new MimoProvider().isAvailable()).toBe(false);
		});
	});

	describe("run", () => {
		it("returns success=true on exit code 0", async () => {
			mockRunProvider.mockResolvedValue(mockSuccess());
			const result = await new MimoProvider().run("do something", opts);
			expect(result.success).toBe(true);
		});

		it("returns success=false on non-zero exit code", async () => {
			mockRunProvider.mockResolvedValue(mockFailure());
			const result = await new MimoProvider().run("do something", opts);
			expect(result.success).toBe(false);
		});

		it("uses mimo run with --dangerously-skip-permissions in command", async () => {
			mockRunProvider.mockResolvedValue(mockSuccess());
			await new MimoProvider().run("do something", opts);

			const config = mockRunProvider.mock.calls[0]![0];
			expect(config.logLine).toContain("mimo run");
			expect(config.logLine).toContain("--dangerously-skip-permissions");
		});

		it("passes the model flag when a model is set", async () => {
			mockRunProvider.mockResolvedValue(mockSuccess());
			await new MimoProvider().run("do something", {
				...opts,
				model: "anthropic/claude-sonnet-4-6",
			});

			const config = mockRunProvider.mock.calls[0]![0];
			expect(config.logLine).toContain("--model anthropic/claude-sonnet-4-6");
		});

		it("rejects a model with unsafe shell characters before spawning", async () => {
			const result = await new MimoProvider().run("do something", {
				...opts,
				model: "bad;rm -rf /",
			});
			expect(result.success).toBe(false);
			expect(result.output).toContain("unsafe characters");
			expect(mockRunProvider).not.toHaveBeenCalled();
		});

		it("returns failure result when run throws", async () => {
			mockRunProvider.mockRejectedValue(new Error("spawn failed"));
			const result = await new MimoProvider().run("do something", opts);
			expect(result.success).toBe(false);
			expect(result.output).toBe("spawn failed");
		});
	});
});
