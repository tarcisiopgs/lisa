import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPrCachePath } from "../paths.js";
import { clearPrUrl, loadPrUrls, storePrUrls } from "./pr-cache.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "lisa-pr-cache-test-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("storePrUrls", () => {
	it("writes the PR URLs array to the cache file", () => {
		storePrUrls(tmpDir, "INT-100", ["https://github.com/owner/repo/pull/42"]);

		const cachePath = getPrCachePath(tmpDir);
		expect(existsSync(cachePath)).toBe(true);
		const content = JSON.parse(readFileSync(cachePath, "utf-8"));
		expect(content["INT-100"]).toEqual(["https://github.com/owner/repo/pull/42"]);
	});

	it("can store multiple issue-to-PR mappings", () => {
		storePrUrls(tmpDir, "INT-100", ["https://github.com/owner/repo/pull/1"]);
		storePrUrls(tmpDir, "INT-200", ["https://github.com/owner/repo/pull/2"]);

		const content = JSON.parse(readFileSync(getPrCachePath(tmpDir), "utf-8"));
		expect(content["INT-100"]).toEqual(["https://github.com/owner/repo/pull/1"]);
		expect(content["INT-200"]).toEqual(["https://github.com/owner/repo/pull/2"]);
	});

	it("stores multiple PR URLs for a single issue", () => {
		storePrUrls(tmpDir, "INT-100", [
			"https://github.com/owner/repo-a/pull/1",
			"https://github.com/owner/repo-b/pull/2",
		]);

		const content = JSON.parse(readFileSync(getPrCachePath(tmpDir), "utf-8"));
		expect(content["INT-100"]).toEqual([
			"https://github.com/owner/repo-a/pull/1",
			"https://github.com/owner/repo-b/pull/2",
		]);
	});

	it("overwrites existing PR URLs for the same issue", () => {
		storePrUrls(tmpDir, "INT-100", ["https://github.com/owner/repo/pull/1"]);
		storePrUrls(tmpDir, "INT-100", ["https://github.com/owner/repo/pull/99"]);

		const content = JSON.parse(readFileSync(getPrCachePath(tmpDir), "utf-8"));
		expect(content["INT-100"]).toEqual(["https://github.com/owner/repo/pull/99"]);
	});

	it("creates the cache directory if it does not exist", () => {
		storePrUrls(tmpDir, "INT-100", ["https://github.com/owner/repo/pull/1"]);
		expect(existsSync(getPrCachePath(tmpDir))).toBe(true);
	});
});

describe("loadPrUrls", () => {
	it("returns the stored PR URLs for a known issue", () => {
		storePrUrls(tmpDir, "INT-100", ["https://github.com/owner/repo/pull/42"]);
		expect(loadPrUrls(tmpDir, "INT-100")).toEqual(["https://github.com/owner/repo/pull/42"]);
	});

	it("returns empty array for an unknown issue", () => {
		expect(loadPrUrls(tmpDir, "INT-999")).toEqual([]);
	});

	it("returns empty array when cache file does not exist", () => {
		expect(loadPrUrls(tmpDir, "INT-100")).toEqual([]);
	});

	it("normalizes legacy single-string entries to an array", () => {
		// Simulate a legacy cache entry written as a single string
		const cachePath = getPrCachePath(tmpDir);
		const dir = join(cachePath, "..");
		if (!existsSync(dir)) {
			const { mkdirSync } = require("node:fs");
			mkdirSync(dir, { recursive: true });
		}
		writeFileSync(
			cachePath,
			JSON.stringify({ "INT-100": "https://github.com/owner/repo/pull/42" }),
			"utf-8",
		);

		expect(loadPrUrls(tmpDir, "INT-100")).toEqual(["https://github.com/owner/repo/pull/42"]);
	});
});

describe("clearPrUrl", () => {
	it("removes the entry for the specified issue", () => {
		storePrUrls(tmpDir, "INT-100", ["https://github.com/owner/repo/pull/42"]);
		clearPrUrl(tmpDir, "INT-100");
		expect(loadPrUrls(tmpDir, "INT-100")).toEqual([]);
	});

	it("does not affect other entries when clearing one", () => {
		storePrUrls(tmpDir, "INT-100", ["https://github.com/owner/repo/pull/1"]);
		storePrUrls(tmpDir, "INT-200", ["https://github.com/owner/repo/pull/2"]);
		clearPrUrl(tmpDir, "INT-100");

		expect(loadPrUrls(tmpDir, "INT-100")).toEqual([]);
		expect(loadPrUrls(tmpDir, "INT-200")).toEqual(["https://github.com/owner/repo/pull/2"]);
	});

	it("does not throw when clearing a non-existent entry", () => {
		expect(() => clearPrUrl(tmpDir, "INT-999")).not.toThrow();
	});

	it("does not throw when cache file does not exist", () => {
		expect(() => clearPrUrl(tmpDir, "INT-100")).not.toThrow();
	});
});
