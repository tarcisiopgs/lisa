import { describe, expect, it, vi } from "vitest";
import {
	DEFAULT_REACTIONS,
	executeNotify,
	parseDuration,
	resolveReaction,
	shouldEscalate,
} from "./reactions.js";

vi.mock("../output/logger.js", () => ({
	log: vi.fn(),
	error: vi.fn(),
	warn: vi.fn(),
	ok: vi.fn(),
}));

describe("parseDuration", () => {
	it("should parse minutes", () => {
		expect(parseDuration("30m")).toBe(1800000);
	});

	it("should parse hours", () => {
		expect(parseDuration("1h")).toBe(3600000);
	});

	it("should parse seconds", () => {
		expect(parseDuration("90s")).toBe(90000);
	});

	it("should return null for invalid input", () => {
		expect(parseDuration("abc")).toBeNull();
		expect(parseDuration(undefined)).toBeNull();
	});
});

describe("resolveReaction", () => {
	it("should return default reaction when no overrides", () => {
		const result = resolveReaction("ci_failed", undefined);
		expect(result.action).toBe("reinvoke");
		expect(result.max_retries).toBe(3);
	});

	it("should merge user overrides with defaults", () => {
		const result = resolveReaction("ci_failed", { ci_failed: { action: "notify" } });
		expect(result.action).toBe("notify");
		expect(result.max_retries).toBe(3);
	});
});

describe("shouldEscalate", () => {
	it("should escalate when retries exceeded", () => {
		const reaction = DEFAULT_REACTIONS.changes_requested;
		expect(shouldEscalate(reaction, 3, Date.now())).toBe(true);
	});

	it("should not escalate within retry limit", () => {
		const reaction = DEFAULT_REACTIONS.changes_requested;
		expect(shouldEscalate(reaction, 1, Date.now())).toBe(false);
	});

	it("should escalate when time threshold exceeded", () => {
		const reaction = { action: "reinvoke" as const, escalate_after: "1m" };
		const twoMinutesAgo = Date.now() - 2 * 60 * 1000;
		expect(shouldEscalate(reaction, 0, twoMinutesAgo)).toBe(true);
	});
});

describe("executeNotify", () => {
	it("should call logger.warn with event and issueId", async () => {
		const logger = await import("../output/logger.js");
		executeNotify("approved", "issue-123");
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("approved"));
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("issue-123"));
	});

	it("should include detail in the warning when provided", async () => {
		const logger = await import("../output/logger.js");
		executeNotify("ci_failed", "issue-456", "Build failed on step lint");
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Build failed on step lint"));
	});
});
