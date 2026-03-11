import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Provider } from "../types/index.js";
import { AiderProvider } from "./aider.js";
import { spawnWithPty } from "./pty.js";

vi.mock("./pty.js", () => ({
	spawnWithPty: vi.fn(() => {
		const proc = new EventEmitter() as NodeJS.EventEmitter & {
			stdout: EventEmitter;
			stderr: EventEmitter;
			pid: number;
			kill: () => void;
		};
		proc.stdout = new EventEmitter();
		proc.stderr = new EventEmitter();
		proc.pid = 12345;
		proc.kill = vi.fn();
		setImmediate(() => proc.emit("close", 0));
		return { proc, isPty: false };
	}),
	stripAnsi: (s: string) => s,
}));

describe("AiderProvider", () => {
	it("has name aider", () => {
		const provider = new AiderProvider();
		expect(provider.name).toBe("aider");
	});

	it("does not support native worktree", () => {
		const provider: Provider = new AiderProvider();
		expect(provider.supportsNativeWorktree).toBeFalsy();
	});

	describe("run", () => {
		afterEach(() => {
			vi.unstubAllEnvs();
			vi.mocked(spawnWithPty).mockClear();
		});

		it("fails fast with clear error when no API key is set", async () => {
			for (const key of [
				"OPENAI_API_KEY",
				"ANTHROPIC_API_KEY",
				"GEMINI_API_KEY",
				"GROQ_API_KEY",
				"OPENROUTER_API_KEY",
				"COHERE_API_KEY",
				"MISTRAL_API_KEY",
				"DEEPSEEK_API_KEY",
				"AZURE_API_KEY",
				"XAI_API_KEY",
			]) {
				vi.stubEnv(key, "");
			}

			const provider = new AiderProvider();
			const result = await provider.run("do something", {
				cwd: "/tmp",
				logFile: "/tmp/test.log",
				env: {},
			});

			expect(result.success).toBe(false);
			expect(result.output).toContain("OPENAI_API_KEY");
			expect(result.output).toContain("ANTHROPIC_API_KEY");
		});

		it("proceeds past API key check when XAI_API_KEY is set", async () => {
			vi.stubEnv("XAI_API_KEY", "xai-test-key");

			const result = await new AiderProvider().run("do something", {
				cwd: "/tmp",
				logFile: "/tmp/test.log",
				env: {},
			});

			expect(result.output).not.toContain("requires a direct LLM API key");
			expect(result.success).toBe(true);
		});

		it("proceeds past API key check and spawns when OPENAI_API_KEY is set", async () => {
			vi.stubEnv("OPENAI_API_KEY", "sk-test-key");

			const provider = new AiderProvider();
			const result = await provider.run("do something", {
				cwd: "/tmp",
				logFile: "/tmp/test.log",
				env: {},
			});

			expect(result.output).not.toContain("requires a direct LLM API key");
			expect(result.success).toBe(true);
		});

		it("uses --message-file instead of shell substitution", async () => {
			vi.stubEnv("OPENAI_API_KEY", "sk-test-key");

			await new AiderProvider().run("do something", {
				cwd: "/tmp",
				logFile: "/tmp/test.log",
				env: {},
			});

			const command = vi.mocked(spawnWithPty).mock.calls[0]![0] as string;
			expect(command).toContain("--message-file");
			expect(command).not.toContain("$(cat");
		});

		it("omits --model flag when no model specified (I-04)", async () => {
			vi.stubEnv("OPENAI_API_KEY", "sk-test-key");

			await new AiderProvider().run("do something", {
				cwd: "/tmp",
				logFile: "/tmp/test.log",
				env: {},
			});

			const command = vi.mocked(spawnWithPty).mock.calls[0]![0] as string;
			expect(command).not.toContain("--model");
		});

		it("includes --model flag when model is specified (I-04)", async () => {
			vi.stubEnv("OPENAI_API_KEY", "sk-test-key");

			await new AiderProvider().run("do something", {
				cwd: "/tmp",
				logFile: "/tmp/test.log",
				env: {},
				model: "gpt-4o",
			});

			const command = vi.mocked(spawnWithPty).mock.calls[0]![0] as string;
			expect(command).toContain("--model gpt-4o");
		});
	});
});
