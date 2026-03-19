import { describe, expect, it } from "vitest";
import { formatError } from "./errors.js";

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
