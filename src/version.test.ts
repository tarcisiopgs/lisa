import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpDir: string;
let checkForUpdate: typeof import("./version.js").checkForUpdate;
let getCachedUpdateInfo: typeof import("./version.js").getCachedUpdateInfo;

describe("version", () => {
	beforeEach(async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "lisa-version-test-"));
		vi.resetModules();
		// Redirect cache to temp dir so tests don't read/write real cache
		vi.stubEnv("XDG_CACHE_HOME", tmpDir);
		vi.stubGlobal("fetch", vi.fn());
		const mod = await import("./version.js");
		checkForUpdate = mod.checkForUpdate;
		getCachedUpdateInfo = mod.getCachedUpdateInfo;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns null when already on latest version", async () => {
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ version: "1.0.0" }),
		} as Response);

		const result = await checkForUpdate("1.0.0");
		expect(result).toBeNull();
	});

	it("returns update info when newer version exists", async () => {
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ version: "2.0.0" }),
		} as Response);

		const result = await checkForUpdate("1.0.0");
		expect(result).toEqual({
			currentVersion: "1.0.0",
			latestVersion: "2.0.0",
			updateType: "major",
		});
	});

	it("detects minor updates", async () => {
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ version: "1.2.0" }),
		} as Response);

		const result = await checkForUpdate("1.1.0");
		expect(result).toEqual({
			currentVersion: "1.1.0",
			latestVersion: "1.2.0",
			updateType: "minor",
		});
	});

	it("detects patch updates", async () => {
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ version: "1.0.2" }),
		} as Response);

		const result = await checkForUpdate("1.0.1");
		expect(result).toEqual({
			currentVersion: "1.0.1",
			latestVersion: "1.0.2",
			updateType: "patch",
		});
	});

	it("returns null on fetch failure", async () => {
		vi.mocked(fetch).mockRejectedValueOnce(new Error("network error"));

		const result = await checkForUpdate("1.0.0");
		expect(result).toBeNull();
	});

	it("returns null on non-ok response", async () => {
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: false,
		} as Response);

		const result = await checkForUpdate("1.0.0");
		expect(result).toBeNull();
	});

	it("getCachedUpdateInfo returns null before any check", () => {
		expect(getCachedUpdateInfo()).toBeNull();
	});

	it("getCachedUpdateInfo returns result after check", async () => {
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ version: "3.0.0" }),
		} as Response);

		await checkForUpdate("1.0.0");
		const cached = getCachedUpdateInfo();
		expect(cached).toEqual({
			currentVersion: "1.0.0",
			latestVersion: "3.0.0",
			updateType: "major",
		});
	});

	it("uses disk cache when check is fresh", async () => {
		// Write a fresh cache file
		const cacheDir = join(tmpDir, "lisa");
		const { mkdirSync } = await import("node:fs");
		mkdirSync(cacheDir, { recursive: true });
		writeFileSync(
			join(cacheDir, "update-check.json"),
			JSON.stringify({ lastCheck: Date.now(), latestVersion: "5.0.0" }),
		);

		// Re-import to get fresh module state
		vi.resetModules();
		vi.stubGlobal("fetch", vi.fn());
		const mod = await import("./version.js");

		const result = await mod.checkForUpdate("1.0.0");
		expect(result).toEqual({
			currentVersion: "1.0.0",
			latestVersion: "5.0.0",
			updateType: "major",
		});
		// fetch should NOT have been called since cache is fresh
		expect(fetch).not.toHaveBeenCalled();
	});
});
