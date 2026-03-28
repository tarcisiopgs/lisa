import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LineageContext } from "../types/index.js";

function lineageDir(workspace: string): string {
	return join(workspace, ".lisa", "lineage");
}

function sanitizePlanId(planId: string): string {
	// Replace characters that are unsafe for filenames
	return planId.replace(/[^a-zA-Z0-9_\-.]/g, "_");
}

function lineagePath(workspace: string, planId: string): string {
	return join(lineageDir(workspace), `${sanitizePlanId(planId)}.json`);
}

/**
 * Save lineage context to `.lisa/lineage/{planId}.json`.
 * Creates the directory if it does not exist.
 */
export function saveLineage(workspace: string, lineage: LineageContext): void {
	const dir = lineageDir(workspace);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	const path = lineagePath(workspace, lineage.planId);
	writeFileSync(path, JSON.stringify(lineage, null, "\t"), "utf-8");
}

/**
 * Load a lineage context by planId. Returns null if the file does not exist.
 */
export function loadLineage(workspace: string, planId: string): LineageContext | null {
	const path = lineagePath(workspace, planId);
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as LineageContext;
	} catch {
		return null;
	}
}

/**
 * Scan all lineage files in `.lisa/lineage/` and find the one containing
 * the given issueId in its `issues` array. Returns null if not found.
 */
export function loadLineageForIssue(workspace: string, issueId: string): LineageContext | null {
	const dir = lineageDir(workspace);
	if (!existsSync(dir)) return null;

	let files: string[];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".json"));
	} catch {
		return null;
	}

	for (const file of files) {
		try {
			const raw = readFileSync(join(dir, file), "utf-8");
			const lineage = JSON.parse(raw) as LineageContext;
			if (lineage.issues.some((issue) => issue.id === issueId)) {
				return lineage;
			}
		} catch {
			// Skip malformed files
		}
	}

	return null;
}

/**
 * Build a markdown block describing this task's place in a decomposed plan.
 * Returns an empty string if the lineage has only one issue (no siblings).
 */
export function buildLineagePromptBlock(lineage: LineageContext, currentIssueId: string): string {
	if (lineage.issues.length <= 1) return "";

	const sorted = [...lineage.issues].sort((a, b) => a.order - b.order);

	const taskList = sorted
		.map((issue, idx) => {
			const marker = issue.id === currentIssueId ? " <-- (this task)" : "";
			return `  ${idx + 1}. [${issue.id}] ${issue.title}${marker}`;
		})
		.join("\n");

	const siblings = sorted
		.filter((issue) => issue.id !== currentIssueId)
		.map((issue) => `- [${issue.id}] ${issue.title}`)
		.join("\n");

	return `## Task Hierarchy

**Goal:** ${lineage.goal}

This task is part of a decomposed plan with ${lineage.issues.length} subtasks:

${taskList}

## Parallel Work

The following sibling tasks may be running concurrently. Do NOT duplicate their work:

${siblings}`;
}
