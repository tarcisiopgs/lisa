import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LisaConfig } from "../../types/index.js";

vi.mock("../../config.js", () => ({
	findConfigDir: vi.fn(),
	loadConfig: vi.fn(),
}));

vi.mock("../../plan/index.js", () => ({
	runPlan: vi.fn().mockResolvedValue(undefined),
}));

import { findConfigDir, loadConfig } from "../../config.js";
import { runPlan } from "../../plan/index.js";
import { CliError } from "../error.js";
import { plan } from "./plan.js";

const mockFindConfigDir = vi.mocked(findConfigDir);
const mockLoadConfig = vi.mocked(loadConfig);
const mockRunPlan = vi.mocked(runPlan);

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

// Helper to invoke the plan command's run function with typed args
async function runPlanCommand(args: Record<string, unknown>) {
	const run = plan.run!;
	return run({ args: { _: [], ...args } as never, rawArgs: [], cmd: {} as never });
}

describe("plan command", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("has correct meta name", () => {
		const meta = plan.meta as unknown as { name: string };
		expect(meta.name).toBe("plan");
	});

	it("defines all expected args", () => {
		const args = plan.args as unknown as Record<string, { type: string }>;
		expect(args.goal?.type).toBe("positional");
		expect(args.issue?.type).toBe("string");
		expect(args.continue?.type).toBe("boolean");
		expect(args.json?.type).toBe("boolean");
		expect(args.yes?.type).toBe("boolean");
		expect(args["no-brainstorm"]?.type).toBe("boolean");
	});

	it("throws CliError when no config found", async () => {
		mockFindConfigDir.mockReturnValue(null);
		await expect(runPlanCommand({ goal: "Add feature" })).rejects.toThrow(CliError);
		await expect(runPlanCommand({ goal: "Add feature" })).rejects.toThrow("lisa init");
	});

	it("calls runPlan with correct options when config exists", async () => {
		const config = makeConfig();
		mockFindConfigDir.mockReturnValue("/project/.lisa");
		mockLoadConfig.mockReturnValue(config);

		await runPlanCommand({
			goal: "Add rate limiting",
			issue: "EPIC-123",
			continue: false,
			json: false,
			yes: false,
			"no-brainstorm": false,
		});

		expect(mockLoadConfig).toHaveBeenCalledWith("/project/.lisa");
		expect(mockRunPlan).toHaveBeenCalledWith({
			config,
			goal: "Add rate limiting",
			issueId: "EPIC-123",
			continueLatest: false,
			jsonOutput: false,
			yes: false,
			noBrainstorm: false,
		});
	});

	it("passes yes: true when --yes flag is set", async () => {
		mockFindConfigDir.mockReturnValue("/project/.lisa");
		mockLoadConfig.mockReturnValue(makeConfig());

		await runPlanCommand({ goal: "Add feature", yes: true });

		expect(mockRunPlan).toHaveBeenCalledWith(expect.objectContaining({ yes: true }));
	});

	it("passes noBrainstorm: true when --no-brainstorm flag is set", async () => {
		mockFindConfigDir.mockReturnValue("/project/.lisa");
		mockLoadConfig.mockReturnValue(makeConfig());

		await runPlanCommand({ goal: "Add feature", "no-brainstorm": true });

		expect(mockRunPlan).toHaveBeenCalledWith(expect.objectContaining({ noBrainstorm: true }));
	});

	it("wraps non-CliError exceptions in CliError", async () => {
		mockFindConfigDir.mockReturnValue("/project/.lisa");
		mockLoadConfig.mockReturnValue(makeConfig());
		mockRunPlan.mockRejectedValueOnce(new Error("unexpected failure"));

		await expect(runPlanCommand({ goal: "Add feature" })).rejects.toThrow(CliError);
	});

	it("re-throws CliError without wrapping", async () => {
		mockFindConfigDir.mockReturnValue("/project/.lisa");
		mockLoadConfig.mockReturnValue(makeConfig());
		const original = new CliError("plan failed", 2);
		mockRunPlan.mockRejectedValueOnce(original);

		await expect(runPlanCommand({ goal: "Add feature" })).rejects.toBe(original);
	});
});
