import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PlanResult } from "../types/index.js";

function plansDir(workspace: string): string {
	return join(workspace, ".lisa", "plans");
}

/** Save a plan to .lisa/plans/{timestamp}.json. Returns the file path. */
export function savePlan(workspace: string, plan: PlanResult): string {
	const dir = plansDir(workspace);
	mkdirSync(dir, { recursive: true });

	const filename = `${plan.createdAt.replace(/[:.]/g, "-")}.json`;
	const filePath = join(dir, filename);
	writeFileSync(filePath, JSON.stringify(plan, null, 2));
	return filePath;
}

/** Load a plan from a specific file path. */
export function loadPlan(filePath: string): PlanResult | null {
	if (!existsSync(filePath)) return null;
	try {
		return JSON.parse(readFileSync(filePath, "utf-8")) as PlanResult;
	} catch {
		return null;
	}
}

/** Load the most recent plan from .lisa/plans/. Returns [plan, filePath] or null. */
export function loadLatestPlan(workspace: string): [PlanResult, string] | null {
	const dir = plansDir(workspace);
	if (!existsSync(dir)) return null;

	const files = readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.sort()
		.reverse();

	for (const file of files) {
		const filePath = join(dir, file);
		const plan = loadPlan(filePath);
		if (plan && plan.status !== "created") return [plan, filePath];
	}
	return null;
}

/** Delete a plan file after successful creation. */
export function deletePlan(filePath: string): void {
	try {
		const { unlinkSync } = require("node:fs") as typeof import("node:fs");
		unlinkSync(filePath);
	} catch {
		// ignore — file may already be deleted
	}
}
