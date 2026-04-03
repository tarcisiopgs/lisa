import { existsSync, readdirSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { warn } from "../output/logger.js";
import { getManifestPath } from "../paths.js";
import type { ExecutionPlan } from "../types/index.js";

export interface LisaManifest {
	repoPath?: string;
	branch?: string;
	prUrl?: string;
}

export function readLisaManifest(cwd: string, issueId?: string): LisaManifest | null {
	const manifestPath = getManifestPath(cwd, issueId);
	if (!existsSync(manifestPath)) return null;
	try {
		return JSON.parse(readFileSync(manifestPath, "utf-8").trim()) as LisaManifest;
	} catch {
		warn(`Failed to parse manifest at ${manifestPath} — agent may not have written it correctly`);
		return null;
	}
}

export function cleanupManifest(cwd: string, issueId?: string): void {
	try {
		unlinkSync(getManifestPath(cwd, issueId));
	} catch {
		/* best-effort cleanup */
	}
}

export function readManifestFile(filePath: string): LisaManifest | null {
	if (!existsSync(filePath)) return null;
	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf-8").trim());
		// Agents may write an array of manifests for multi-repo issues.
		// Extract the first entry that has a prUrl.
		if (Array.isArray(parsed)) {
			return (parsed.find((m: LisaManifest) => m.prUrl) as LisaManifest) ?? null;
		}
		return parsed as LisaManifest;
	} catch {
		/* non-fatal: malformed data */
		return null;
	}
}

export function extractPrUrlFromOutput(output: string): string | null {
	const patterns = [
		/https?:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/,
		/https?:\/\/[^/]*gitlab[^/]*\/[^/].+?\/-\/merge_requests\/\d+/,
		/https?:\/\/bitbucket\.org\/[^/]+\/[^/]+\/pull-requests\/\d+/,
	];
	for (const pattern of patterns) {
		const match = output.match(pattern);
		if (match) return match[0];
	}
	return null;
}

export function readPlanFile(filePath: string): ExecutionPlan | null {
	if (!existsSync(filePath)) return null;
	try {
		return JSON.parse(readFileSync(filePath, "utf-8").trim()) as ExecutionPlan;
	} catch {
		/* non-fatal: malformed data */
		return null;
	}
}

/**
 * Remove a plan file and clean up the parent directory if it becomes empty.
 */
export function cleanupPlanFile(filePath: string): void {
	try {
		unlinkSync(filePath);
	} catch {
		/* best-effort cleanup */
	}
	try {
		const dir = dirname(filePath);
		if (existsSync(dir) && readdirSync(dir).length === 0) {
			rmdirSync(dir);
		}
	} catch {
		/* best-effort cleanup */
	}
}
