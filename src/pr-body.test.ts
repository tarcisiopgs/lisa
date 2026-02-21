import { describe, expect, it } from "vitest";
import { sanitizePrBody } from "./pr-body.js";

describe("sanitizePrBody", () => {
	it("trims leading and trailing whitespace", () => {
		expect(sanitizePrBody("  hello world  ")).toBe("hello world");
	});

	it("trims leading and trailing blank lines", () => {
		expect(sanitizePrBody("\n\nhello\n\n")).toBe("hello");
	});

	it("normalizes * bullets to - bullets", () => {
		expect(sanitizePrBody("* item one\n* item two")).toBe("- item one\n- item two");
	});

	it("does not change - bullets", () => {
		expect(sanitizePrBody("- item one\n- item two")).toBe("- item one\n- item two");
	});

	it("normalizes nested * bullets to - bullets", () => {
		expect(sanitizePrBody("* top\n  * nested item")).toBe("- top\n  - nested item");
	});

	it("strips HTML tags", () => {
		expect(sanitizePrBody("hello <b>world</b>")).toBe("hello world");
	});

	it("strips self-closing HTML tags", () => {
		expect(sanitizePrBody("hello<br/>world")).toBe("helloworld");
	});

	it("converts wall of text to bullet points", () => {
		const wall =
			"Added new endpoint for users. Fixed validation bug. Updated tests to cover edge cases.";
		const result = sanitizePrBody(wall);
		expect(result).toContain("- Added new endpoint for users");
		expect(result).toContain("- Fixed validation bug");
		expect(result).toContain("- Updated tests to cover edge cases");
	});

	it("does not split text that already has newlines", () => {
		const formatted = "- Added new endpoint\n- Fixed bug";
		expect(sanitizePrBody(formatted)).toBe("- Added new endpoint\n- Fixed bug");
	});

	it("returns empty string for empty input", () => {
		expect(sanitizePrBody("")).toBe("");
	});

	it("returns empty string for whitespace-only input", () => {
		expect(sanitizePrBody("   \n\n  ")).toBe("");
	});

	it("preserves markdown formatting like bold and code", () => {
		expect(sanitizePrBody("**bold** and `code`")).toBe("**bold** and `code`");
	});
});
