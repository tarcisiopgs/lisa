import { describe, expect, it, vi } from "vitest";
import type { LisaConfig } from "../types/index.js";
import { buildPlanningPrompt } from "./prompt.js";

vi.mock("../session/context-manager.js", () => ({
	readContext: () => "# Project Context\nThis is a TypeScript project.",
}));

function makeConfig(overrides?: Partial<LisaConfig>): LisaConfig {
	return {
		provider: "claude",
		source: "linear",
		source_config: {
			scope: "Engineering",
			project: "Web",
			label: "ready",
			pick_from: "Backlog",
			in_progress: "In Progress",
			done: "Done",
		},
		platform: "cli",
		workflow: "worktree",
		workspace: "/tmp/test-workspace",
		base_branch: "main",
		repos: [],
		loop: { cooldown: 10, max_sessions: 10 },
		...overrides,
	} as LisaConfig;
}

describe("buildPlanningPrompt", () => {
	it("includes the goal in the prompt", () => {
		const prompt = buildPlanningPrompt("Add rate limiting", makeConfig());
		expect(prompt).toContain("Add rate limiting");
	});

	it("includes single-repo info when repos is empty", () => {
		const prompt = buildPlanningPrompt("goal", makeConfig());
		expect(prompt).toContain("single-repo");
		expect(prompt).toContain("main");
	});

	it("includes multi-repo info when repos are configured", () => {
		const config = makeConfig({
			repos: [
				{ name: "api", path: "./api", base_branch: "main", match: "" },
				{ name: "web", path: "./web", base_branch: "main", match: "" },
			],
		});
		const prompt = buildPlanningPrompt("goal", config);
		expect(prompt).toContain("**api**");
		expect(prompt).toContain("**web**");
		expect(prompt).toContain("repo");
	});

	it("includes parent issue description when provided", () => {
		const prompt = buildPlanningPrompt("goal", makeConfig(), "Epic description here");
		expect(prompt).toContain("Parent Issue Description");
		expect(prompt).toContain("Epic description here");
	});

	it("omits parent block when not provided", () => {
		const prompt = buildPlanningPrompt("goal", makeConfig());
		expect(prompt).not.toContain("Parent Issue Description");
	});

	it("includes context.md content", () => {
		const prompt = buildPlanningPrompt("goal", makeConfig());
		expect(prompt).toContain("Project Context");
	});

	it("includes JSON output format instruction", () => {
		const prompt = buildPlanningPrompt("goal", makeConfig());
		expect(prompt).toContain('"issues"');
		expect(prompt).toContain("acceptanceCriteria");
		expect(prompt).toContain("dependsOn");
	});

	it("omits repo field instruction for single-repo", () => {
		const prompt = buildPlanningPrompt("goal", makeConfig());
		expect(prompt).not.toContain('"repo":"..."');
	});

	it("includes repo field instruction for multi-repo", () => {
		const config = makeConfig({
			repos: [
				{ name: "api", path: "./api", base_branch: "main", match: "" },
				{ name: "web", path: "./web", base_branch: "main", match: "" },
			],
		});
		const prompt = buildPlanningPrompt("goal", config);
		expect(prompt).toContain('"repo":"..."');
	});
});
