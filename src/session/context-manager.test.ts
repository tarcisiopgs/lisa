import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contextExists, getContextPath, readContext, writeContext } from "./context-manager.js";

let tmpDir: string;
beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "lisa-ctx-mgr-"));
});
afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("getContextPath", () => {
	it("returns .lisa/context.md path", () => {
		expect(getContextPath(tmpDir)).toBe(join(tmpDir, ".lisa", "context.md"));
	});
});

describe("contextExists", () => {
	it("returns false when file does not exist", () => {
		expect(contextExists(tmpDir)).toBe(false);
	});

	it("returns true when .lisa/context.md exists", () => {
		mkdirSync(join(tmpDir, ".lisa"), { recursive: true });
		writeFileSync(join(tmpDir, ".lisa", "context.md"), "# context");
		expect(contextExists(tmpDir)).toBe(true);
	});
});

describe("readContext", () => {
	it("returns null when file does not exist", () => {
		expect(readContext(tmpDir)).toBeNull();
	});

	it("returns file content when exists", () => {
		mkdirSync(join(tmpDir, ".lisa"), { recursive: true });
		writeFileSync(join(tmpDir, ".lisa", "context.md"), "# My Context\n\nHello");
		expect(readContext(tmpDir)).toBe("# My Context\n\nHello");
	});
});

describe("writeContext", () => {
	it("creates .lisa directory and writes file", () => {
		writeContext(tmpDir, "# Generated Context");
		const content = readFileSync(join(tmpDir, ".lisa", "context.md"), "utf-8");
		expect(content).toBe("# Generated Context");
	});

	it("overwrites existing content", () => {
		writeContext(tmpDir, "# Old");
		writeContext(tmpDir, "# New");
		expect(readContext(tmpDir)).toBe("# New");
	});
});
