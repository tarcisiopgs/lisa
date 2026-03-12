import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Provider } from "../types/index.js";
import { CursorProvider, createStreamJsonTransform } from "./cursor.js";
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

describe("createStreamJsonTransform", () => {
	it("formats assistant messages as plain text", () => {
		const transform = createStreamJsonTransform();
		const input = `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "I'll read the file" }] } })}\n`;
		expect(transform(input)).toBe("I'll read the file\n");
	});

	it("formats tool_call started events with path", () => {
		const transform = createStreamJsonTransform();
		const input = `${JSON.stringify({ type: "tool_call", subtype: "started", call_id: "1", tool_call: { readToolCall: { args: { path: "src/index.ts" } } } })}\n`;
		expect(transform(input)).toBe("● Read src/index.ts\n");
	});

	it("formats tool_call started events with command", () => {
		const transform = createStreamJsonTransform();
		const input = `${JSON.stringify({ type: "tool_call", subtype: "started", call_id: "1", tool_call: { runCommandToolCall: { args: { command: "npm test" } } } })}\n`;
		expect(transform(input)).toBe("● Run npm test\n");
	});

	it("formats tool_call completed errors", () => {
		const transform = createStreamJsonTransform();
		const input = `${JSON.stringify({ type: "tool_call", subtype: "completed", call_id: "1", tool_call: { editToolCall: { args: { path: "file.ts" }, result: { error: "No match found" } } } })}\n`;
		expect(transform(input)).toBe("✗ Edit — No match found\n");
	});

	it("suppresses tool_call completed success events", () => {
		const transform = createStreamJsonTransform();
		const input = `${JSON.stringify({ type: "tool_call", subtype: "completed", call_id: "1", tool_call: { readToolCall: { args: { path: "file.ts" }, result: { success: { content: "..." } } } } })}\n`;
		expect(transform(input)).toBe("");
	});

	it("suppresses system and user events", () => {
		const transform = createStreamJsonTransform();
		const sys = `${JSON.stringify({ type: "system", subtype: "init" })}\n`;
		const user = `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "prompt" }] } })}\n`;
		expect(transform(sys)).toBe("");
		expect(transform(user)).toBe("");
	});

	it("handles partial lines across chunks", () => {
		const transform = createStreamJsonTransform();
		const full = JSON.stringify({
			type: "assistant",
			message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
		});
		// Split in the middle
		const part1 = full.slice(0, 20);
		const part2 = `${full.slice(20)}\n`;
		expect(transform(part1)).toBe("");
		expect(transform(part2)).toBe("hello\n");
	});

	it("passes through non-JSON lines", () => {
		const transform = createStreamJsonTransform();
		expect(transform("some plain text output\n")).toBe("some plain text output\n");
	});
});

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

			// execSync called once for "which agent" only, not again in run()
			expect(vi.mocked(execSync)).toHaveBeenCalledTimes(1);
		});

		it("includes --output-format stream-json --force in command", async () => {
			const { execSync } = await import("node:child_process");
			vi.mocked(execSync).mockReturnValue(Buffer.from(""));

			const provider = new CursorProvider();
			await provider.run("do something", {
				cwd: "/tmp",
				logFile: "/tmp/test.log",
				env: {},
			});

			const command = vi.mocked(spawnWithPty).mock.calls[0]![0] as string;
			expect(command).toContain("--output-format stream-json");
			expect(command).toContain("--force");
		});
	});
});
