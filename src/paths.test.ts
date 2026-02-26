import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ensureCacheDir,
	getCacheDir,
	getGuardrailsPath,
	getLogsDir,
	getManifestPath,
	getPlanPath,
	projectHash,
	rotateLogFiles,
} from "./paths.js";

describe("projectHash", () => {
	it("returns a 12-character hex string", () => {
		const hash = projectHash("/some/project");
		expect(hash).toMatch(/^[a-f0-9]{12}$/);
	});

	it("returns the same hash for the same path", () => {
		expect(projectHash("/some/project")).toBe(projectHash("/some/project"));
	});

	it("returns different hashes for different paths", () => {
		expect(projectHash("/project-a")).not.toBe(projectHash("/project-b"));
	});

	it("resolves relative paths before hashing", () => {
		const cwd = process.cwd();
		expect(projectHash(".")).toBe(projectHash(cwd));
	});
});

describe("getCacheDir", () => {
	it("returns path under ~/.cache/lisa/<hash>", () => {
		const dir = getCacheDir("/my/project");
		const hash = projectHash("/my/project");
		expect(dir).toBe(join(homedir(), ".cache", "lisa", hash));
	});

	it("respects XDG_CACHE_HOME", () => {
		const original = process.env.XDG_CACHE_HOME;
		process.env.XDG_CACHE_HOME = "/custom/cache";
		try {
			const dir = getCacheDir("/my/project");
			const hash = projectHash("/my/project");
			expect(dir).toBe(join("/custom/cache", "lisa", hash));
		} finally {
			if (original === undefined) {
				delete process.env.XDG_CACHE_HOME;
			} else {
				process.env.XDG_CACHE_HOME = original;
			}
		}
	});
});

describe("getLogsDir", () => {
	it("returns logs/ under cache dir", () => {
		const dir = getLogsDir("/my/project");
		expect(dir).toBe(join(getCacheDir("/my/project"), "logs"));
	});
});

describe("getGuardrailsPath", () => {
	it("returns guardrails.md under cache dir", () => {
		const path = getGuardrailsPath("/my/project");
		expect(path).toBe(join(getCacheDir("/my/project"), "guardrails.md"));
	});
});

describe("getManifestPath", () => {
	it("returns manifest.json under cache dir when no issueId", () => {
		const path = getManifestPath("/my/project");
		expect(path).toBe(join(getCacheDir("/my/project"), "manifest.json"));
	});

	it("returns per-issue manifest path when issueId is provided", () => {
		const path = getManifestPath("/my/project", "INT-123");
		expect(path).toBe(join(getCacheDir("/my/project"), "manifest-INT-123.json"));
	});

	it("sanitizes special characters in issueId", () => {
		const path = getManifestPath("/my/project", "ORG/PROJ#42");
		expect(path).toBe(join(getCacheDir("/my/project"), "manifest-ORG_PROJ_42.json"));
	});
});

describe("getPlanPath", () => {
	it("returns plan.json under cache dir when no issueId", () => {
		const path = getPlanPath("/my/project");
		expect(path).toBe(join(getCacheDir("/my/project"), "plan.json"));
	});

	it("returns per-issue plan path when issueId is provided", () => {
		const path = getPlanPath("/my/project", "INT-456");
		expect(path).toBe(join(getCacheDir("/my/project"), "plan-INT-456.json"));
	});

	it("sanitizes special characters in issueId", () => {
		const path = getPlanPath("/my/project", "ORG/PROJ#99");
		expect(path).toBe(join(getCacheDir("/my/project"), "plan-ORG_PROJ_99.json"));
	});
});

describe("ensureCacheDir", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(require("node:os").tmpdir(), "lisa-paths-test-"));
	});

	afterEach(() => {
		// Clean up the cache dir we created
		const cacheDir = getCacheDir(tmpDir);
		rmSync(cacheDir, { recursive: true, force: true });
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("creates the cache directory if it does not exist", () => {
		ensureCacheDir(tmpDir);
		const cacheDir = getCacheDir(tmpDir);
		expect(statSync(cacheDir).isDirectory()).toBe(true);
	});

	it("does not throw if cache directory already exists", () => {
		ensureCacheDir(tmpDir);
		expect(() => ensureCacheDir(tmpDir)).not.toThrow();
	});
});

describe("rotateLogFiles", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(require("node:os").tmpdir(), "lisa-paths-test-"));
	});

	afterEach(() => {
		const cacheDir = getCacheDir(tmpDir);
		rmSync(cacheDir, { recursive: true, force: true });
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("does nothing when logs dir does not exist", () => {
		expect(() => rotateLogFiles(tmpDir)).not.toThrow();
	});

	it("does nothing when there are fewer than 20 log files", () => {
		const logsDir = getLogsDir(tmpDir);
		mkdirSync(logsDir, { recursive: true });
		for (let i = 0; i < 10; i++) {
			writeFileSync(join(logsDir, `session_${i}.log`), `log ${i}`);
		}
		rotateLogFiles(tmpDir);
		const { readdirSync } = require("node:fs");
		const files = readdirSync(logsDir).filter((f: string) => f.endsWith(".log"));
		expect(files).toHaveLength(10);
	});

	it("removes oldest files when there are more than 20", () => {
		const logsDir = getLogsDir(tmpDir);
		mkdirSync(logsDir, { recursive: true });

		// Create 25 log files with staggered mtimes
		for (let i = 0; i < 25; i++) {
			const filePath = join(logsDir, `session_${String(i).padStart(2, "0")}.log`);
			writeFileSync(filePath, `log ${i}`);
			// Set mtime to ensure ordering (oldest first)
			const { utimesSync } = require("node:fs");
			const baseTime = Date.now() / 1000 - 1000 + i;
			utimesSync(filePath, baseTime, baseTime);
		}

		rotateLogFiles(tmpDir);

		const { readdirSync } = require("node:fs");
		const files = readdirSync(logsDir).filter((f: string) => f.endsWith(".log"));
		expect(files).toHaveLength(20);

		// The 5 oldest files (00-04) should be gone
		const { existsSync } = require("node:fs");
		for (let i = 0; i < 5; i++) {
			expect(existsSync(join(logsDir, `session_${String(i).padStart(2, "0")}.log`))).toBe(false);
		}
		// The newest files (05-24) should remain
		for (let i = 5; i < 25; i++) {
			expect(existsSync(join(logsDir, `session_${String(i).padStart(2, "0")}.log`))).toBe(true);
		}
	});

	it("ignores non-.log files", () => {
		const logsDir = getLogsDir(tmpDir);
		mkdirSync(logsDir, { recursive: true });

		for (let i = 0; i < 22; i++) {
			writeFileSync(join(logsDir, `session_${i}.log`), `log ${i}`);
		}
		writeFileSync(join(logsDir, "readme.txt"), "not a log file");

		rotateLogFiles(tmpDir);

		const { readdirSync, existsSync } = require("node:fs");
		const allFiles = readdirSync(logsDir);
		const logFiles = allFiles.filter((f: string) => f.endsWith(".log"));
		expect(logFiles).toHaveLength(20);
		expect(existsSync(join(logsDir, "readme.txt"))).toBe(true);
	});
});
