import { describe, expect, it } from "vitest";
import { formatElapsed, getLastOutputLine, stripDoubleWidth, wrapTitle } from "./card.js";

describe("stripDoubleWidth", () => {
	it("returns ASCII strings unchanged", () => {
		expect(stripDoubleWidth("hello world")).toBe("hello world");
	});

	it("returns empty string unchanged", () => {
		expect(stripDoubleWidth("")).toBe("");
	});

	it("replaces CJK unified ideograph characters with ?", () => {
		expect(stripDoubleWidth("你好")).toBe("??");
	});

	it("replaces Hangul syllables with ?", () => {
		expect(stripDoubleWidth("안녕하세요")).toBe("?????");
	});

	it("replaces full-width ASCII variants with ?", () => {
		// Full-width letters: Ａ = U+FF21
		expect(stripDoubleWidth("ＡＢＣ")).toBe("???");
	});

	it("replaces astral-plane emoji with ?", () => {
		expect(stripDoubleWidth("hello 🎉 world")).toBe("hello ? world");
	});

	it("handles mixed ASCII and wide chars correctly", () => {
		expect(stripDoubleWidth("hi 你好 world")).toBe("hi ?? world");
	});

	it("ensures padEnd produces correct length after stripping", () => {
		// "你好" = 2 CJK chars → stripped to "??" (2 chars), padEnd(10) → 10 chars
		const stripped = stripDoubleWidth("你好");
		const padded = stripped.padEnd(10);
		expect(padded.length).toBe(10);
	});

	it("replaces Hiragana characters with ?", () => {
		// U+3041–U+3096 Hiragana
		expect(stripDoubleWidth("あいう")).toBe("???");
	});
});

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

describe("formatElapsed", () => {
	it("formats sub-minute durations as seconds", () => {
		expect(formatElapsed(0)).toBe("0s");
		expect(formatElapsed(999)).toBe("0s");
		expect(formatElapsed(1000)).toBe("1s");
		expect(formatElapsed(59000)).toBe("59s");
	});

	it("formats durations >= 1 minute as Xm Ys", () => {
		expect(formatElapsed(60000)).toBe("1m 0s");
		expect(formatElapsed(61000)).toBe("1m 1s");
		expect(formatElapsed(90000)).toBe("1m 30s");
		expect(formatElapsed(3661000)).toBe("61m 1s");
	});

	it("rounds down partial seconds", () => {
		expect(formatElapsed(1500)).toBe("1s");
		expect(formatElapsed(119999)).toBe("1m 59s");
	});
});

describe("wrapTitle", () => {
	const maxWidth = 28;

	it("returns title as-is when it fits in one line", () => {
		expect(wrapTitle("short title", maxWidth)).toEqual(["short title", ""]);
	});

	it("returns title exactly at maxWidth with empty second line", () => {
		const title = "a".repeat(28);
		expect(wrapTitle(title, maxWidth)).toEqual([title, ""]);
	});

	it("wraps at word boundary when title exceeds maxWidth", () => {
		const title = "fix the kanban card height during initialization";
		const [line1, line2] = wrapTitle(title, maxWidth);
		expect(line1.length).toBeLessThanOrEqual(maxWidth);
		expect(line2.length).toBeLessThanOrEqual(maxWidth);
		expect(`${line1} ${line2}`.trim()).toBe(title);
	});

	it("truncates second line with ellipsis when remaining text is too long", () => {
		const title = "word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11";
		const [line1, line2] = wrapTitle(title, maxWidth);
		expect(line1.length).toBeLessThanOrEqual(maxWidth);
		expect(line2.length).toBeLessThanOrEqual(maxWidth);
		expect(line2.endsWith("…")).toBe(true);
	});

	it("hard-cuts a single word longer than maxWidth", () => {
		const longWord = "a".repeat(40);
		const [line1, line2] = wrapTitle(longWord, maxWidth);
		expect(line1).toBe("a".repeat(28));
		// rest is 12 chars (40 - 28), which fits within maxWidth — no ellipsis
		expect(line2).toBe("a".repeat(12));
	});

	it("hard-cuts with ellipsis when remainder also exceeds maxWidth", () => {
		const longWord = "a".repeat(80);
		const [line1, line2] = wrapTitle(longWord, maxWidth);
		expect(line1.length).toBe(maxWidth);
		expect(line2.length).toBe(maxWidth);
		expect(line2.endsWith("…")).toBe(true);
	});

	it("works with a smaller maxWidth (e.g. 20)", () => {
		const title = "fix the kanban layout issue quickly";
		const [line1, line2] = wrapTitle(title, 20);
		expect(line1.length).toBeLessThanOrEqual(20);
		expect(line2.length).toBeLessThanOrEqual(20);
	});
});
