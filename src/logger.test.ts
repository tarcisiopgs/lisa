import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initLogFile, setOutputMode } from "./logger.js";

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
		initLogFile(logPath);

		const content = readFileSync(logPath, "utf-8");
		expect(content).toContain("Log started");
	});

	it("creates nested directories if needed", () => {
		const logPath = join(tmpDir, "nested", "dir", "test.log");
		initLogFile(logPath);

		const content = readFileSync(logPath, "utf-8");
		expect(content).toContain("Log started");
	});
});

describe("setOutputMode and JSON events", () => {
	afterEach(() => {
		setOutputMode("default");
	});

	it("accumulates JSON events when in json mode", async () => {
		setOutputMode("json");
		const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		// Import dynamically to get fresh state
		const logger = await import("./logger.js");
		const eventsBefore = logger.getJsonEvents().length;

		logger.log("test message");

		const events = logger.getJsonEvents();
		expect(events.length).toBeGreaterThan(eventsBefore);

		const lastEvent = events[events.length - 1] as { level: string; message: string };
		expect(lastEvent?.level).toBe("info");
		expect(lastEvent?.message).toBe("test message");

		consoleSpy.mockRestore();
	});
});
