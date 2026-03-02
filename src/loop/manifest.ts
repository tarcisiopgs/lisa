import { existsSync, readFileSync, unlinkSync } from "node:fs";
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
		return null;
	}
}

export function cleanupManifest(cwd: string, issueId?: string): void {
	try {
		unlinkSync(getManifestPath(cwd, issueId));
	} catch {}
}

export function readManifestFile(filePath: string): LisaManifest | null {
	if (!existsSync(filePath)) return null;
	try {
		return JSON.parse(readFileSync(filePath, "utf-8").trim()) as LisaManifest;
	} catch {
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
		return null;
	}
}
