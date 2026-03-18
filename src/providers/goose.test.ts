import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Provider } from "../types/index.js";
import { GooseProvider } from "./goose.js";
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

describe("GooseProvider", () => {
	beforeEach(() => {
		vi.mocked(spawnWithPty).mockImplementation(() => makeFakeProc() as never);
	});

	afterEach(() => {
		vi.resetAllMocks();
		vi.unstubAllEnvs();
	});

	it("has name goose", () => {
		expect(new GooseProvider().name).toBe("goose");
	});

	it("does not support native worktree", () => {
		const provider: Provider = new GooseProvider();
		expect(provider.supportsNativeWorktree).toBeFalsy();
	});

	describe("isAvailable", () => {
		it("returns true when goose binary is found", async () => {
			vi.mocked(isCommandAvailable).mockResolvedValue(true);
			expect(await new GooseProvider().isAvailable()).toBe(true);
			expect(vi.mocked(isCommandAvailable)).toHaveBeenCalledWith("goose");
		});

		it("returns false when goose binary is not found", async () => {
			vi.mocked(isCommandAvailable).mockResolvedValue(false);
			expect(await new GooseProvider().isAvailable()).toBe(false);
		});
	});

	describe("run", () => {
		it("returns success=true on exit code 0", async () => {
			const result = await new GooseProvider().run("do something", {
				cwd: "/tmp",
				logFile: "/tmp/test.log",
				env: {},
			});
			expect(result.success).toBe(true);
		});

		it("returns success=false on non-zero exit code", async () => {
			vi.mocked(spawnWithPty).mockImplementation(() => makeFakeProc(1) as never);

			const result = await new GooseProvider().run("do something", {
				cwd: "/tmp",
				logFile: "/tmp/test.log",
				env: {},
			});
			expect(result.success).toBe(false);
		});

		it("omits --provider flag when GOOSE_PROVIDER is not set (I-06)", async () => {
			vi.stubEnv("GOOSE_PROVIDER", "");

			await new GooseProvider().run("do something", {
				cwd: "/tmp",
				logFile: "/tmp/test.log",
				env: {},
			});

			const command = vi.mocked(spawnWithPty).mock.calls[0]![0] as string;
			expect(command).not.toContain("--provider");
		});

		it("includes --provider flag when GOOSE_PROVIDER is set (I-06)", async () => {
			vi.stubEnv("GOOSE_PROVIDER", "gemini-cli");

			await new GooseProvider().run("do something", {
				cwd: "/tmp",
				logFile: "/tmp/test.log",
				env: {},
			});

			const command = vi.mocked(spawnWithPty).mock.calls[0]![0] as string;
			expect(command).toContain("--provider gemini-cli");
		});

		it("includes --model flag when model is specified", async () => {
			await new GooseProvider().run("do something", {
				cwd: "/tmp",
				logFile: "/tmp/test.log",
				env: {},
				model: "gemini-2.5-pro",
			});

			const command = vi.mocked(spawnWithPty).mock.calls[0]![0] as string;
			expect(command).toContain("--model gemini-2.5-pro");
		});

		it("omits --model flag when no model is specified", async () => {
			await new GooseProvider().run("do something", {
				cwd: "/tmp",
				logFile: "/tmp/test.log",
				env: {},
			});

			const command = vi.mocked(spawnWithPty).mock.calls[0]![0] as string;
			expect(command).not.toContain("--model");
		});
	});
});
