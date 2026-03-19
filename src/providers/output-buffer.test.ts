import { afterEach, describe, expect, it, vi } from "vitest";
import { escapeShellPath, OutputBuffer, safeAppendLog } from "./output-buffer.js";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, appendFileSync: vi.fn() };
});

vi.mock("../output/logger.js", () => ({
	warn: vi.fn(),
}));

describe("escapeShellPath", () => {
	it("returns path unchanged when no special characters", () => {
		expect(escapeShellPath("/tmp/test/file.txt")).toBe("/tmp/test/file.txt");
	});

	it("escapes single quotes", () => {
		expect(escapeShellPath("/tmp/it's a file")).toBe("/tmp/it'\\''s a file");
	});

	it("throws on control characters", () => {
		expect(() => escapeShellPath("/tmp/file\x00name")).toThrow("control characters");
	});

	it("throws on newline in path", () => {
		expect(() => escapeShellPath("/tmp/file\nname")).toThrow("control characters");
	});
});

describe("OutputBuffer", () => {
	it("returns empty string when no data pushed", () => {
		const buf = new OutputBuffer();
		expect(buf.toString()).toBe("");
	});

	it("returns single chunk without joining", () => {
		const buf = new OutputBuffer();
		buf.push("hello");
		expect(buf.toString()).toBe("hello");
	});

	it("joins multiple chunks", () => {
		const buf = new OutputBuffer();
		buf.push("hello ");
		buf.push("world");
		expect(buf.toString()).toBe("hello world");
	});

	it("evicts oldest chunks when over budget", () => {
		const buf = new OutputBuffer(10);
		buf.push("aaaa"); // 4 bytes
		buf.push("bbbb"); // 4 bytes, total 8
		buf.push("cccc"); // 4 bytes, total 12 - over budget
		const result = buf.toString();
		// Should have evicted 'aaaa', keeping 'bbbb' + 'cccc' = 8 bytes
		expect(result).not.toContain("aaaa");
		expect(result).toContain("cccc");
	});

	it("trims a single oversized chunk from the start", () => {
		const buf = new OutputBuffer(5);
		buf.push("0123456789"); // 10 bytes, single chunk > 5 byte cap
		expect(buf.toString()).toBe("56789");
	});

	it("compacts internal state on toString", () => {
		const buf = new OutputBuffer();
		buf.push("a");
		buf.push("b");
		buf.push("c");
		expect(buf.toString()).toBe("abc");
		// Second call should return same result from compacted state
		expect(buf.toString()).toBe("abc");
	});
});

describe("safeAppendLog", () => {
	afterEach(() => {
		vi.resetAllMocks();
	});

	it("does not throw on write failure", async () => {
		const { appendFileSync } = await import("node:fs");
		vi.mocked(appendFileSync).mockImplementation(() => {
			throw new Error("EACCES");
		});
		expect(() => safeAppendLog("/readonly/file.log", "data")).not.toThrow();
	});
});
