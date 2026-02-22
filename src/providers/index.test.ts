import { describe, expect, it } from "vitest";
import { createProvider, isEligibleForFallback } from "./index.js";

describe("createProvider", () => {
	it("creates a claude provider", () => {
		const provider = createProvider("claude");
		expect(provider.name).toBe("claude");
	});

	it("creates a gemini provider", () => {
		const provider = createProvider("gemini");
		expect(provider.name).toBe("gemini");
	});

	it("creates an opencode provider", () => {
		const provider = createProvider("opencode");
		expect(provider.name).toBe("opencode");
	});

	it("creates a copilot provider", () => {
		const provider = createProvider("copilot");
		expect(provider.name).toBe("copilot");
	});
	it("creates a cursor provider", () => {
		const provider = createProvider("cursor");
		expect(provider.name).toBe("cursor");
	});

	it("throws for unknown provider", () => {
		expect(() => createProvider("unknown" as never)).toThrow("Unknown provider: unknown");
	});
});

describe("supportsNativeWorktree", () => {
	it("claude provider supports native worktree", () => {
		const provider = createProvider("claude");
		expect(provider.supportsNativeWorktree).toBe(true);
	});

	it("gemini provider does not support native worktree", () => {
		const provider = createProvider("gemini");
		expect(provider.supportsNativeWorktree).toBeFalsy();
	});

	it("opencode provider does not support native worktree", () => {
		const provider = createProvider("opencode");
		expect(provider.supportsNativeWorktree).toBeFalsy();
	});

	it("copilot provider does not support native worktree", () => {
		const provider = createProvider("copilot");
		expect(provider.supportsNativeWorktree).toBeFalsy();
	});
	it("cursor provider does not support native worktree", () => {
		const provider = createProvider("cursor");
		expect(provider.supportsNativeWorktree).toBeFalsy();
	});
});

describe("isEligibleForFallback", () => {
	it("returns true for rate limit errors", () => {
		expect(isEligibleForFallback("Error 429: Too Many Requests")).toBe(true);
		expect(isEligibleForFallback("rate limit exceeded")).toBe(true);
		expect(isEligibleForFallback("Rate Limit reached")).toBe(true);
	});

	it("returns true for quota errors", () => {
		expect(isEligibleForFallback("quota exceeded")).toBe(true);
		expect(isEligibleForFallback("resource exhausted")).toBe(true);
	});

	it("returns true for unavailability errors", () => {
		expect(isEligibleForFallback("service unavailable")).toBe(true);
		expect(isEligibleForFallback("model overloaded")).toBe(true);
	});

	it("returns true for network errors", () => {
		expect(isEligibleForFallback("ETIMEDOUT")).toBe(true);
		expect(isEligibleForFallback("ECONNREFUSED")).toBe(true);
		expect(isEligibleForFallback("ECONNRESET")).toBe(true);
		expect(isEligibleForFallback("ENOTFOUND")).toBe(true);
		expect(isEligibleForFallback("connection timed out")).toBe(true);
		expect(isEligibleForFallback("network error occurred")).toBe(true);
	});

	it("returns true for model not found errors", () => {
		expect(isEligibleForFallback("model not found")).toBe(true);
		expect(isEligibleForFallback("The model does not exist")).toBe(true);
	});

	it("returns true for installation errors", () => {
		expect(isEligibleForFallback("claude is not installed")).toBe(true);
		expect(isEligibleForFallback("not in PATH")).toBe(true);
		expect(isEligibleForFallback("command not found")).toBe(true);
	});

	it("returns false for non-eligible errors", () => {
		expect(isEligibleForFallback("SyntaxError: Unexpected token")).toBe(false);
		expect(isEligibleForFallback("TypeError: Cannot read properties")).toBe(false);
		expect(isEligibleForFallback("Implementation complete")).toBe(false);
		expect(isEligibleForFallback("Build failed with errors")).toBe(false);
	});
});
