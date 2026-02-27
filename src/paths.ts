import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const MAX_LOG_FILES = 20;

export function projectHash(cwd: string): string {
	const absolute = resolve(cwd);
	return createHash("sha256").update(absolute).digest("hex").slice(0, 12);
}

export function getCacheDir(cwd: string): string {
	const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
	return join(base, "lisa", projectHash(cwd));
}

export function getLogsDir(cwd: string): string {
	return join(getCacheDir(cwd), "logs");
}

export function getGuardrailsPath(cwd: string): string {
	return join(getCacheDir(cwd), "guardrails.md");
}

export function getManifestPath(cwd: string, issueId?: string): string {
	if (issueId) {
		const safe = issueId.replace(/[^a-zA-Z0-9_-]/g, "_");
		return join(getCacheDir(cwd), `manifest-${safe}.json`);
	}
	return join(getCacheDir(cwd), "manifest.json");
}

export function getPrCachePath(cwd: string): string {
	return join(getCacheDir(cwd), "pr-cache.json");
}

export function getPlanPath(cwd: string, issueId?: string): string {
	if (issueId) {
		const safe = issueId.replace(/[^a-zA-Z0-9_-]/g, "_");
		return join(getCacheDir(cwd), `plan-${safe}.json`);
	}
	return join(getCacheDir(cwd), "plan.json");
}

export function ensureCacheDir(cwd: string): void {
	const dir = getCacheDir(cwd);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

export function rotateLogFiles(cwd: string): void {
	const logsDir = getLogsDir(cwd);
	if (!existsSync(logsDir)) return;

	const files = readdirSync(logsDir)
		.filter((f) => f.endsWith(".log"))
		.map((f) => ({
			name: f,
			path: join(logsDir, f),
			mtime: statSync(join(logsDir, f)).mtimeMs,
		}))
		.sort((a, b) => a.mtime - b.mtime);

	const excess = files.length - MAX_LOG_FILES;
	if (excess <= 0) return;

	for (const file of files.slice(0, excess)) {
		try {
			unlinkSync(file.path);
		} catch {
			// Ignore deletion errors
		}
	}
}
