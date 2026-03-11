import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

const PACKAGE_NAME = "@tarcisiopgs/lisa";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_TIMEOUT_MS = 3000;

interface UpdateCache {
	lastCheck: number;
	latestVersion: string | null;
}

function getCachePath(): string {
	let base: string;
	if (process.env.XDG_CACHE_HOME) {
		base = process.env.XDG_CACHE_HOME;
	} else if (platform() === "darwin") {
		base = join(homedir(), "Library", "Caches");
	} else {
		base = join(homedir(), ".cache");
	}
	return join(base, "lisa", "update-check.json");
}

function readCache(): UpdateCache | null {
	try {
		const raw = readFileSync(getCachePath(), "utf-8");
		return JSON.parse(raw) as UpdateCache;
	} catch {
		return null;
	}
}

function writeCache(cache: UpdateCache): void {
	try {
		const path = getCachePath();
		const dir = join(path, "..");
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		writeFileSync(path, JSON.stringify(cache));
	} catch {
		// Silent — caching is best-effort
	}
}

function compareVersions(current: string, latest: string): "major" | "minor" | "patch" | null {
	const [cMajor = 0, cMinor = 0, cPatch = 0] = current.split(".").map(Number);
	const [lMajor = 0, lMinor = 0, lPatch = 0] = latest.split(".").map(Number);

	if (lMajor > cMajor) return "major";
	if (lMajor === cMajor && lMinor > cMinor) return "minor";
	if (lMajor === cMajor && lMinor === cMinor && lPatch > cPatch) return "patch";
	return null;
}

export interface UpdateInfo {
	currentVersion: string;
	latestVersion: string;
	updateType: "major" | "minor" | "patch";
}

let cachedResult: UpdateInfo | null | undefined;

/**
 * Check for a newer version of Lisa on npm.
 * Non-blocking — uses a 24h cache to avoid spamming the registry.
 * Returns null if up-to-date, fetch fails, or check was skipped.
 */
export async function checkForUpdate(currentVersion: string): Promise<UpdateInfo | null> {
	if (cachedResult !== undefined) return cachedResult;

	try {
		const cache = readCache();

		// Use cached result if fresh enough
		if (cache && Date.now() - cache.lastCheck < CHECK_INTERVAL_MS) {
			if (cache.latestVersion) {
				const updateType = compareVersions(currentVersion, cache.latestVersion);
				cachedResult = updateType
					? { currentVersion, latestVersion: cache.latestVersion, updateType }
					: null;
				return cachedResult;
			}
			cachedResult = null;
			return null;
		}

		// Fetch latest version from npm registry
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

		const response = await fetch(
			`https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}/latest`,
			{ signal: controller.signal },
		);
		clearTimeout(timeout);

		if (!response.ok) {
			writeCache({ lastCheck: Date.now(), latestVersion: null });
			cachedResult = null;
			return null;
		}

		const data = (await response.json()) as { version?: string };
		const latestVersion = data.version ?? null;

		writeCache({ lastCheck: Date.now(), latestVersion });

		if (latestVersion) {
			const updateType = compareVersions(currentVersion, latestVersion);
			cachedResult = updateType ? { currentVersion, latestVersion, updateType } : null;
			return cachedResult;
		}

		cachedResult = null;
		return null;
	} catch {
		cachedResult = null;
		return null;
	}
}

/**
 * Returns cached update info synchronously (for TUI use).
 * Must call checkForUpdate() first to populate the cache.
 */
export function getCachedUpdateInfo(): UpdateInfo | null {
	return cachedResult ?? null;
}
