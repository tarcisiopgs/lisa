import { beforeEach, describe, expect, it, vi } from "vitest";
import { CliError } from "../cli/error.js";
import type { LisaConfig, PlannedIssue, RunResult } from "../types/index.js";
import { PlanParseError } from "./parser.js";

const validIssues: PlannedIssue[] = [
	{
		title: "Add rate limiter",
		description: "Create rate limiting middleware",
		acceptanceCriteria: ["Returns 429 on limit", "Uses Redis"],
		relevantFiles: ["src/middleware/rate-limit.ts"],
		order: 1,
		dependsOn: [],
	},
];

const validJson = JSON.stringify({ issues: validIssues });

const successResult: RunResult = {
	success: true,
	output: validJson,
	duration: 5,
};

const failureResult: RunResult = {
	success: false,
	output: "provider crashed",
	duration: 1,
};

vi.mock("../providers/index.js", () => ({
	runWithFallback: vi.fn(),
}));

vi.mock("../loop/models.js", () => ({
	resolveModels: vi.fn(() => [{ provider: "claude", model: "claude-sonnet-4-6" }]),
}));

vi.mock("./prompt.js", () => ({
	buildPlanningPrompt: vi.fn(() => "mock prompt"),
}));

vi.mock("../output/logger.js", () => ({
	log: vi.fn(),
	warn: vi.fn(),
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

describe("generatePlan", () => {
	let runWithFallback: ReturnType<typeof vi.fn>;
	let buildPlanningPrompt: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		vi.clearAllMocks();
		const providers = await import("../providers/index.js");
		runWithFallback = providers.runWithFallback as ReturnType<typeof vi.fn>;
		const prompt = await import("./prompt.js");
		buildPlanningPrompt = prompt.buildPlanningPrompt as ReturnType<typeof vi.fn>;
	});

	it("returns parsed issues on successful provider response", async () => {
		runWithFallback.mockResolvedValueOnce(successResult);

		const { generatePlan } = await import("./generate.js");
		const issues = await generatePlan("Add rate limiting", makeConfig());

		expect(issues).toHaveLength(1);
		expect(issues[0]!.title).toBe("Add rate limiter");
		expect(runWithFallback).toHaveBeenCalledOnce();
	});

	it("throws CliError when provider fails", async () => {
		runWithFallback.mockResolvedValue(failureResult);

		const { generatePlan } = await import("./generate.js");
		await expect(generatePlan("goal", makeConfig())).rejects.toThrow(CliError);
		await expect(generatePlan("goal", makeConfig())).rejects.toThrow(
			/AI provider failed to generate plan/,
		);
	});

	it("retries parsing when first attempt fails with PlanParseError", async () => {
		// First call returns unparseable output, retry returns valid output
		runWithFallback
			.mockResolvedValueOnce({ success: true, output: "not json", duration: 3 })
			.mockResolvedValueOnce(successResult);

		const { generatePlan } = await import("./generate.js");
		const issues = await generatePlan("goal", makeConfig());

		expect(issues).toHaveLength(1);
		expect(issues[0]!.title).toBe("Add rate limiter");
		// First call for initial attempt, second for retry
		expect(runWithFallback).toHaveBeenCalledTimes(2);
	});

	it("throws CliError after MAX_PARSE_RETRIES+1 failures", async () => {
		// All attempts return unparseable output (initial + 2 retries = 3 calls)
		runWithFallback.mockResolvedValue({ success: true, output: "bad", duration: 1 });

		const { generatePlan } = await import("./generate.js");
		await expect(generatePlan("goal", makeConfig())).rejects.toThrow(CliError);
		await expect(generatePlan("goal", makeConfig())).rejects.toThrow(
			/Failed to parse AI response after 3 attempts/,
		);
	});

	it("appends regeneration feedback to prompt when opts.feedback provided", async () => {
		runWithFallback.mockResolvedValueOnce(successResult);

		const { generatePlan } = await import("./generate.js");
		await generatePlan("goal", makeConfig(), { feedback: "Make issues smaller" });

		const calledPrompt = runWithFallback.mock.calls[0]![1] as string;
		expect(calledPrompt).toContain("Regeneration Feedback");
		expect(calledPrompt).toContain("Make issues smaller");
	});

	it("includes previous titles in regeneration prompt", async () => {
		runWithFallback.mockResolvedValueOnce(successResult);

		const { generatePlan } = await import("./generate.js");
		await generatePlan("goal", makeConfig(), {
			feedback: "Split the first issue",
			previousTitles: ["Add rate limiter", "Wire to routes"],
		});

		const calledPrompt = runWithFallback.mock.calls[0]![1] as string;
		expect(calledPrompt).toContain("previous plan had 2 issues");
		expect(calledPrompt).toContain("Add rate limiter, Wire to routes");
	});

	it("passes parentDescription to buildPlanningPrompt", async () => {
		runWithFallback.mockResolvedValueOnce(successResult);

		const { generatePlan } = await import("./generate.js");
		await generatePlan("goal", makeConfig(), { parentDescription: "Epic details" });

		expect(buildPlanningPrompt).toHaveBeenCalledWith("goal", expect.anything(), "Epic details");
	});

	it("re-throws non-PlanParseError exceptions immediately", async () => {
		// Return valid provider result but mock parsePlanResponse to throw a non-PlanParseError
		runWithFallback.mockResolvedValueOnce({
			success: true,
			output: '{"issues":[{"title":"T","description":"D"}]}',
			duration: 1,
		});

		// The TypeError from bad data structure will propagate as-is (not wrapped in CliError)
		// Instead, test with a provider that succeeds but whose output triggers a real error
		// by checking that a non-parse error from retry does not get swallowed
		runWithFallback
			.mockReset()
			.mockResolvedValueOnce({ success: true, output: "bad", duration: 1 })
			.mockRejectedValueOnce(new Error("network error"));

		const { generatePlan } = await import("./generate.js");
		await expect(generatePlan("goal", makeConfig())).rejects.toThrow("network error");
	});
});
