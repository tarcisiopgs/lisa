import { describe, expect, it } from "vitest";
import {
	formatError,
	LisaError,
	ProviderError,
	SourceError,
	TimeoutError,
	ValidationError,
} from "./errors.js";

describe("formatError", () => {
	it("extracts message from Error instance", () => {
		expect(formatError(new Error("test error"))).toBe("test error");
	});

	it("converts string to string", () => {
		expect(formatError("string error")).toBe("string error");
	});

	it("converts number to string", () => {
		expect(formatError(42)).toBe("42");
	});

	it("converts null to string", () => {
		expect(formatError(null)).toBe("null");
	});

	it("converts undefined to string", () => {
		expect(formatError(undefined)).toBe("undefined");
	});
});

describe("LisaError", () => {
	it("has correct name and message", () => {
		const err = new LisaError("base error");
		expect(err.name).toBe("LisaError");
		expect(err.message).toBe("base error");
		expect(err).toBeInstanceOf(Error);
	});

	it("supports cause option", () => {
		const cause = new Error("root cause");
		const err = new LisaError("wrapper", { cause });
		expect(err.cause).toBe(cause);
		expect(formatError(err)).toBe("wrapper (caused by: root cause)");
	});
});

describe("ProviderError", () => {
	it("has correct name, message, provider, and model", () => {
		const err = new ProviderError("agent crashed", "claude", "claude-sonnet-4-6");
		expect(err.name).toBe("ProviderError");
		expect(err.message).toBe("agent crashed");
		expect(err.provider).toBe("claude");
		expect(err.model).toBe("claude-sonnet-4-6");
		expect(err).toBeInstanceOf(LisaError);
		expect(err).toBeInstanceOf(Error);
	});

	it("works without model", () => {
		const err = new ProviderError("timeout", "gemini");
		expect(err.model).toBeUndefined();
	});
});

describe("SourceError", () => {
	it("has correct name, message, source, and statusCode", () => {
		const err = new SourceError("not found", "linear", 404);
		expect(err.name).toBe("SourceError");
		expect(err.message).toBe("not found");
		expect(err.source).toBe("linear");
		expect(err.statusCode).toBe(404);
		expect(err).toBeInstanceOf(LisaError);
		expect(err).toBeInstanceOf(Error);
	});

	it("works without statusCode", () => {
		const err = new SourceError("auth missing", "github-issues");
		expect(err.statusCode).toBeUndefined();
	});
});

describe("TimeoutError", () => {
	it("has correct name, message, and timeoutMs", () => {
		const err = new TimeoutError("session timed out", 300_000);
		expect(err.name).toBe("TimeoutError");
		expect(err.message).toBe("session timed out");
		expect(err.timeoutMs).toBe(300_000);
		expect(err).toBeInstanceOf(LisaError);
		expect(err).toBeInstanceOf(Error);
	});
});

describe("ValidationError", () => {
	it("has correct name and message", () => {
		const err = new ValidationError("lint failed");
		expect(err.name).toBe("ValidationError");
		expect(err.message).toBe("lint failed");
		expect(err).toBeInstanceOf(LisaError);
		expect(err).toBeInstanceOf(Error);
	});
});
