import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getPrCachePath } from "../paths.js";

type PrCache = Record<string, string>; // issueId → prUrl

function readCache(cwd: string): PrCache {
	const path = getPrCachePath(cwd);
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as PrCache;
	} catch {
		return {};
	}
}

function writeCache(cwd: string, cache: PrCache): void {
	const path = getPrCachePath(cwd);
	const dir = dirname(path);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(path, JSON.stringify(cache, null, 2), "utf-8");
}

/**
 * Stores the PR URL associated with an issue for future feedback injection.
 */
export function storePrUrl(cwd: string, issueId: string, prUrl: string): void {
	const cache = readCache(cwd);
	cache[issueId] = prUrl;
	writeCache(cwd, cache);
}

/**
 * Retrieves the stored PR URL for an issue, or null if not found.
 */
export function loadPrUrl(cwd: string, issueId: string): string | null {
	return readCache(cwd)[issueId] ?? null;
}

/**
 * Removes the stored PR URL for an issue after feedback has been injected.
 */
export function clearPrUrl(cwd: string, issueId: string): void {
	const cache = readCache(cwd);
	delete cache[issueId];
	writeCache(cwd, cache);
}
