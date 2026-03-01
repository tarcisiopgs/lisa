import { afterEach, describe, expect, it, vi } from "vitest";
import type { Provider } from "../types/index.js";
import { AiderProvider } from "./aider.js";

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
		});

		it("fails fast with clear error when no API key is set", async () => {
			// Ensure none of the known API key vars are set
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

		it("proceeds when OPENAI_API_KEY is set", async () => {
			vi.stubEnv("OPENAI_API_KEY", "sk-test-key");

			// We only verify it doesn't fail with the API key error — actual aider execution
			// would fail in a test environment, but we don't want to test that here.
			const provider = new AiderProvider();
			// If it gets past the API key check, it will try to spawn aider and fail differently
			// (not with the "requires a direct LLM API key" message)
			const result = await provider.run("do something", {
				cwd: "/tmp",
				logFile: "/tmp/test.log",
				env: {},
			});

			expect(result.output).not.toContain("requires a direct LLM API key");
		});
	});
});
