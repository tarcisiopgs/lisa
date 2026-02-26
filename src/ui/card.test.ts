import { describe, expect, it } from "vitest";
import { getLastOutputLine } from "./card.js";

describe("getLastOutputLine", () => {
	const maxWidth = 28;

	it("returns empty string for empty log", () => {
		expect(getLastOutputLine("", maxWidth)).toBe("");
	});

	it("returns empty string for whitespace-only log", () => {
		expect(getLastOutputLine("   \n  \n\n", maxWidth)).toBe("");
	});

	it("returns the last non-empty line", () => {
		const log = "first line\nsecond line\nthird line\n";
		expect(getLastOutputLine(log, maxWidth)).toBe("third line");
	});

	it("skips trailing empty lines", () => {
		const log = "first line\nsecond line\n\n\n";
		expect(getLastOutputLine(log, maxWidth)).toBe("second line");
	});

	it("strips ANSI color codes", () => {
		const log = "\x1B[32mgreen text\x1B[0m\n\x1B[31mred line\x1B[0m\n";
		expect(getLastOutputLine(log, maxWidth)).toBe("red line");
	});

	it("strips ANSI CSI sequences (bold, cursor, etc.)", () => {
		const log = "\x1B[1mbold\x1B[0m\n\x1B[2Acursor up\n";
		expect(getLastOutputLine(log, maxWidth)).toBe("cursor up");
	});

	it("strips OSC sequences (terminal title)", () => {
		const log = "\x1B]0;window title\x07\nactual output\n";
		expect(getLastOutputLine(log, maxWidth)).toBe("actual output");
	});

	it("truncates long lines with ellipsis", () => {
		const longLine = "a".repeat(40);
		const result = getLastOutputLine(longLine, maxWidth);
		expect(result.length).toBe(maxWidth);
		expect(result).toBe(`${"a".repeat(27)}…`);
	});

	it("does not truncate lines within maxWidth", () => {
		const line = "short line";
		expect(getLastOutputLine(line, maxWidth)).toBe("short line");
	});

	it("does not truncate lines exactly at maxWidth", () => {
		const line = "a".repeat(28);
		expect(getLastOutputLine(line, maxWidth)).toBe(line);
	});

	it("handles carriage returns within lines", () => {
		const log = "progress 50%\rprogress 100%\n";
		expect(getLastOutputLine(log, maxWidth)).toBe("progress 100%");
	});

	it("handles mixed ANSI codes and carriage returns", () => {
		const log = "\x1B[33mloading...\x1B[0m\r\x1B[32mdone\x1B[0m\nfinal line\n";
		expect(getLastOutputLine(log, maxWidth)).toBe("final line");
	});

	it("returns single line log", () => {
		expect(getLastOutputLine("only line", maxWidth)).toBe("only line");
	});

	it("trims whitespace from the last line", () => {
		const log = "first\n  padded line  \n";
		expect(getLastOutputLine(log, maxWidth)).toBe("padded line");
	});
});
