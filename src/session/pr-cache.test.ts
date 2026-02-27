import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPrCachePath } from "../paths.js";
import { clearPrUrl, loadPrUrl, storePrUrl } from "./pr-cache.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "lisa-pr-cache-test-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("storePrUrl", () => {
	it("writes the PR URL to the cache file", () => {
		storePrUrl(tmpDir, "INT-100", "https://github.com/owner/repo/pull/42");

		const cachePath = getPrCachePath(tmpDir);
		expect(existsSync(cachePath)).toBe(true);
		const content = JSON.parse(readFileSync(cachePath, "utf-8")) as Record<string, string>;
		expect(content["INT-100"]).toBe("https://github.com/owner/repo/pull/42");
	});

	it("can store multiple issue-to-PR mappings", () => {
		storePrUrl(tmpDir, "INT-100", "https://github.com/owner/repo/pull/1");
		storePrUrl(tmpDir, "INT-200", "https://github.com/owner/repo/pull/2");

		const content = JSON.parse(readFileSync(getPrCachePath(tmpDir), "utf-8")) as Record<
			string,
			string
		>;
		expect(content["INT-100"]).toBe("https://github.com/owner/repo/pull/1");
		expect(content["INT-200"]).toBe("https://github.com/owner/repo/pull/2");
	});

	it("overwrites an existing PR URL for the same issue", () => {
		storePrUrl(tmpDir, "INT-100", "https://github.com/owner/repo/pull/1");
		storePrUrl(tmpDir, "INT-100", "https://github.com/owner/repo/pull/99");

		const content = JSON.parse(readFileSync(getPrCachePath(tmpDir), "utf-8")) as Record<
			string,
			string
		>;
		expect(content["INT-100"]).toBe("https://github.com/owner/repo/pull/99");
	});

	it("creates the cache directory if it does not exist", () => {
		// The cache dir is derived from cwd — verify it handles a fresh tmpDir with no cache dir
		storePrUrl(tmpDir, "INT-100", "https://github.com/owner/repo/pull/1");
		expect(existsSync(getPrCachePath(tmpDir))).toBe(true);
	});
});

describe("loadPrUrl", () => {
	it("returns the stored PR URL for a known issue", () => {
		storePrUrl(tmpDir, "INT-100", "https://github.com/owner/repo/pull/42");
		expect(loadPrUrl(tmpDir, "INT-100")).toBe("https://github.com/owner/repo/pull/42");
	});

	it("returns null for an unknown issue", () => {
		expect(loadPrUrl(tmpDir, "INT-999")).toBeNull();
	});

	it("returns null when cache file does not exist", () => {
		expect(loadPrUrl(tmpDir, "INT-100")).toBeNull();
	});
});

describe("clearPrUrl", () => {
	it("removes the entry for the specified issue", () => {
		storePrUrl(tmpDir, "INT-100", "https://github.com/owner/repo/pull/42");
		clearPrUrl(tmpDir, "INT-100");
		expect(loadPrUrl(tmpDir, "INT-100")).toBeNull();
	});

	it("does not affect other entries when clearing one", () => {
		storePrUrl(tmpDir, "INT-100", "https://github.com/owner/repo/pull/1");
		storePrUrl(tmpDir, "INT-200", "https://github.com/owner/repo/pull/2");
		clearPrUrl(tmpDir, "INT-100");

		expect(loadPrUrl(tmpDir, "INT-100")).toBeNull();
		expect(loadPrUrl(tmpDir, "INT-200")).toBe("https://github.com/owner/repo/pull/2");
	});

	it("does not throw when clearing a non-existent entry", () => {
		expect(() => clearPrUrl(tmpDir, "INT-999")).not.toThrow();
	});

	it("does not throw when cache file does not exist", () => {
		expect(() => clearPrUrl(tmpDir, "INT-100")).not.toThrow();
	});
});
