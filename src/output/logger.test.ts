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
		logger.setLogLevel("default");
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("prints to stderr in default mode", () => {
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
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
		logger.setLogLevel("default");
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("suppresses console output but still writes to file in tui mode", () => {
		const logPath = join(tmpDir, "test.log");
		logger.initLogFile(logPath);
		logger.setOutputMode("tui");

		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
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

describe("setLogLevel", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "lisa-loglevel-test-"));
		logger.initLogFile(join(tmpDir, "test.log"));
		logger.setOutputMode("default");
		logger.setLogLevel("default");
	});

	afterEach(() => {
		logger.setOutputMode("default");
		logger.setLogLevel("default");
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("suppresses console output in quiet mode", () => {
		logger.setLogLevel("quiet");
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			logger.log("should not print");
			expect(consoleSpy).not.toHaveBeenCalled();
		} finally {
			consoleSpy.mockRestore();
		}
	});

	it("still writes to log file in quiet mode", () => {
		const logPath = join(tmpDir, "quiet.log");
		logger.initLogFile(logPath);
		logger.setLogLevel("quiet");

		logger.log("quiet file message");

		const content = readFileSync(logPath, "utf-8");
		expect(content).toContain("quiet file message");
	});

	it("suppresses banner in quiet mode", () => {
		logger.setLogLevel("quiet");
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			logger.banner();
			expect(consoleSpy).not.toHaveBeenCalled();
		} finally {
			consoleSpy.mockRestore();
		}
	});

	it("verbose() only prints in verbose mode", () => {
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			logger.verbose("should not print in default");
			expect(consoleSpy).not.toHaveBeenCalled();

			logger.setLogLevel("verbose");
			logger.verbose("should print in verbose");
			expect(consoleSpy).toHaveBeenCalledTimes(1);
		} finally {
			consoleSpy.mockRestore();
		}
	});

	it("verbose() writes to log file in verbose mode", () => {
		const logPath = join(tmpDir, "verbose.log");
		logger.initLogFile(logPath);
		logger.setLogLevel("verbose");

		logger.verbose("verbose file message");

		const content = readFileSync(logPath, "utf-8");
		expect(content).toContain("verbose file message");
	});
});
