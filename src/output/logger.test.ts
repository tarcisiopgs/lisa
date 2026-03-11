import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as logger from "./logger.js";

describe("initLogFile", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "lisa-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("creates a log file with a timestamp header", () => {
		const logPath = join(tmpDir, "test.log");
		logger.initLogFile(logPath);

		const content = readFileSync(logPath, "utf-8");
		expect(content).toContain("Log started");
	});

	it("creates nested directories if needed", () => {
		const logPath = join(tmpDir, "nested", "dir", "test.log");
		logger.initLogFile(logPath);

		const content = readFileSync(logPath, "utf-8");
		expect(content).toContain("Log started");
	});
});

describe("setOutputMode", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "lisa-test-"));
		// Point log file to a valid path so appendFileSync doesn't fail
		logger.initLogFile(join(tmpDir, "test.log"));
		logger.setOutputMode("default");
	});

	afterEach(() => {
		logger.setOutputMode("default");
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("prints to console in default mode", () => {
		const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			logger.log("test message");
			expect(consoleSpy).toHaveBeenCalled();
		} finally {
			consoleSpy.mockRestore();
		}
	});
});

describe("tui output mode", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "lisa-tui-test-"));
	});

	afterEach(() => {
		logger.setOutputMode("default");
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("suppresses console output but still writes to file in tui mode", () => {
		const logPath = join(tmpDir, "test.log");
		logger.initLogFile(logPath);
		logger.setOutputMode("tui");

		const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			logger.log("hello from tui");
			expect(consoleSpy).not.toHaveBeenCalled();
		} finally {
			consoleSpy.mockRestore();
		}

		const content = readFileSync(logPath, "utf-8");
		expect(content).toContain("hello from tui");
	});
});
