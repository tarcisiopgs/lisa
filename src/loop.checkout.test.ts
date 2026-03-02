import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("execa", () => ({
	execa: vi.fn(),
}));

import { execa } from "execa";
import { checkoutBaseBranches } from "./loop.js";
import type { LisaConfig } from "./types/index.js";

function makeConfig(overrides: Partial<LisaConfig> = {}): LisaConfig {
	return {
		provider: "claude",
		source: "linear",
		source_config: {
			team: "t",
			project: "p",
			label: "ready",
			pick_from: "todo",
			in_progress: "in_progress",
			done: "done",
		},
		platform: "cli",
		workflow: "branch",
		workspace: "/workspace",
		base_branch: "main",
		repos: [],
		loop: { cooldown: 0, max_sessions: 1 },
		...overrides,
	} as LisaConfig;
}

describe("checkoutBaseBranches", () => {
	beforeEach(() => {
		vi.mocked(execa).mockResolvedValue({ stdout: "", stderr: "" } as never);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("checks out base_branch in the workspace when no repos configured", async () => {
		const config = makeConfig({ workspace: "/workspace", base_branch: "main", repos: [] });
		await checkoutBaseBranches(config, "/workspace");
		expect(execa).toHaveBeenCalledWith("git", ["checkout", "main"], { cwd: "/workspace" });
		expect(execa).toHaveBeenCalledTimes(1);
	});

	it("checks out base_branch in workspace and each configured repo", async () => {
		const appPath = resolve("/workspace", "./app");
		const apiPath = resolve("/workspace", "./api");
		const config = makeConfig({
			workspace: "/workspace",
			base_branch: "main",
			repos: [
				{ name: "app", path: "./app", match: "App:", base_branch: "develop" },
				{ name: "api", path: "./api", match: "API:", base_branch: "main" },
			],
		});
		await checkoutBaseBranches(config, "/workspace");
		expect(execa).toHaveBeenCalledWith("git", ["checkout", "main"], { cwd: "/workspace" });
		expect(execa).toHaveBeenCalledWith("git", ["checkout", "develop"], { cwd: appPath });
		expect(execa).toHaveBeenCalledWith("git", ["checkout", "main"], { cwd: apiPath });
		expect(execa).toHaveBeenCalledTimes(3);
	});

	it("continues when checkout fails", async () => {
		vi.mocked(execa).mockRejectedValueOnce(new Error("dirty working tree"));
		const config = makeConfig({ workspace: "/workspace", base_branch: "main", repos: [] });
		await expect(checkoutBaseBranches(config, "/workspace")).resolves.toBeUndefined();
	});
});
