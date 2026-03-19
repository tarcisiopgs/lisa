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

describe("getOutputMode / getLogLevel", () => {
	afterEach(() => {
		logger.setOutputMode("default");
		logger.setLogLevel("default");
	});

	it("returns the current output mode", () => {
		expect(logger.getOutputMode()).toBe("default");
		logger.setOutputMode("tui");
		expect(logger.getOutputMode()).toBe("tui");
	});

	it("returns the current log level", () => {
		expect(logger.getLogLevel()).toBe("default");
		logger.setLogLevel("quiet");
		expect(logger.getLogLevel()).toBe("quiet");
	});
});

describe("warn / error / ok", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "lisa-log-funcs-"));
		logger.initLogFile(join(tmpDir, "test.log"));
		logger.setOutputMode("default");
		logger.setLogLevel("default");
	});

	afterEach(() => {
		logger.setOutputMode("default");
		logger.setLogLevel("default");
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("warn prints to stderr and writes to file", () => {
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			logger.warn("warn message");
			expect(consoleSpy).toHaveBeenCalled();
		} finally {
			consoleSpy.mockRestore();
		}
		const content = readFileSync(join(tmpDir, "test.log"), "utf-8");
		expect(content).toContain("warn message");
	});

	it("error prints to stderr and writes to file", () => {
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			logger.error("error message");
			expect(consoleSpy).toHaveBeenCalled();
		} finally {
			consoleSpy.mockRestore();
		}
		const content = readFileSync(join(tmpDir, "test.log"), "utf-8");
		expect(content).toContain("error message");
	});

	it("ok prints to stderr and writes to file", () => {
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			logger.ok("ok message");
			expect(consoleSpy).toHaveBeenCalled();
		} finally {
			consoleSpy.mockRestore();
		}
		const content = readFileSync(join(tmpDir, "test.log"), "utf-8");
		expect(content).toContain("ok message");
	});
});

describe("banner", () => {
	afterEach(() => {
		logger.setOutputMode("default");
		logger.setLogLevel("default");
	});

	it("prints banner in default mode", () => {
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			logger.banner();
			expect(consoleSpy).toHaveBeenCalled();
		} finally {
			consoleSpy.mockRestore();
		}
	});

	it("suppresses banner in tui mode", () => {
		logger.setOutputMode("tui");
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			logger.banner();
			expect(consoleSpy).not.toHaveBeenCalled();
		} finally {
			consoleSpy.mockRestore();
		}
	});
});

describe("updateNotice", () => {
	afterEach(() => {
		logger.setOutputMode("default");
		logger.setLogLevel("default");
	});

	it("prints update notice in default mode", () => {
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			logger.updateNotice({
				currentVersion: "1.0.0",
				latestVersion: "2.0.0",
				updateType: "major" as const,
			});
			expect(consoleSpy).toHaveBeenCalled();
		} finally {
			consoleSpy.mockRestore();
		}
	});

	it("suppresses update notice in tui mode", () => {
		logger.setOutputMode("tui");
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			logger.updateNotice({
				currentVersion: "1.0.0",
				latestVersion: "2.0.0",
				updateType: "major" as const,
			});
			expect(consoleSpy).not.toHaveBeenCalled();
		} finally {
			consoleSpy.mockRestore();
		}
	});

	it("suppresses update notice in quiet mode", () => {
		logger.setLogLevel("quiet");
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			logger.updateNotice({
				currentVersion: "1.0.0",
				latestVersion: "2.0.0",
				updateType: "major" as const,
			});
			expect(consoleSpy).not.toHaveBeenCalled();
		} finally {
			consoleSpy.mockRestore();
		}
	});
});

describe("divider", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "lisa-divider-"));
		logger.initLogFile(join(tmpDir, "test.log"));
		logger.setOutputMode("default");
		logger.setLogLevel("default");
	});

	afterEach(() => {
		logger.setOutputMode("default");
		logger.setLogLevel("default");
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("writes session divider", () => {
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			logger.divider(1);
			expect(consoleSpy).toHaveBeenCalled();
		} finally {
			consoleSpy.mockRestore();
		}
		const content = readFileSync(join(tmpDir, "test.log"), "utf-8");
		expect(content).toContain("Session 1");
	});
});
