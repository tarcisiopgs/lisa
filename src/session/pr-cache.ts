import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { getPrCachePath } from "../paths.js";

type PrCache = Record<string, string | string[]>; // issueId → prUrl(s)

function readCache(cwd: string): PrCache {
	const path = getPrCachePath(cwd);
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as PrCache;
	} catch {
		return {};
	}
}

function writeCacheSafe(cwd: string, cache: PrCache): void {
	const path = getPrCachePath(cwd);
	const dir = dirname(path);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	// Write to a temp file then rename for atomicity (prevents concurrent corruption)
	const tmpPath = `${path}.tmp.${process.pid}`;
	const data = JSON.stringify(cache, null, 2);
	writeFileSync(tmpPath, data, "utf-8");
	try {
		renameSync(tmpPath, path);
	} catch {
		// Fallback: direct write if rename fails (e.g., cross-device)
		writeFileSync(path, data, "utf-8");
		try {
			unlinkSync(tmpPath);
		} catch {
			/* best-effort cleanup */
		}
	}
}

/**
 * Stores PR URLs associated with an issue for future feedback injection.
 */
export function storePrUrls(cwd: string, issueId: string, prUrls: string[]): void {
	const cache = readCache(cwd);
	cache[issueId] = prUrls;
	writeCacheSafe(cwd, cache);
}

/**
 * Retrieves the stored PR URLs for an issue.
 * Normalizes legacy single-string entries to an array.
 */
export function loadPrUrls(cwd: string, issueId: string): string[] {
	const entry = readCache(cwd)[issueId];
	if (!entry) return [];
	return Array.isArray(entry) ? entry : [entry];
}

/**
 * Removes the stored PR URL for an issue after feedback has been injected.
 */
export function clearPrUrl(cwd: string, issueId: string): void {
	const cache = readCache(cwd);
	delete cache[issueId];
	writeCacheSafe(cwd, cache);
}
