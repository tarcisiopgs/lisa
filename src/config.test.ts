import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configExists, getConfigPath, loadConfig, mergeWithFlags, saveConfig } from "./config.js";
import type { LisaConfig } from "./types.js";

describe("getConfigPath", () => {
	it("returns .lisa/config.yaml path relative to cwd", () => {
		const path = getConfigPath("/some/dir");
		expect(path).toBe("/some/dir/.lisa/config.yaml");
	});
});

describe("configExists", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "lisa-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns false when config file does not exist", () => {
		expect(configExists(tmpDir)).toBe(false);
	});

	it("returns true when config file exists", () => {
		const configDir = join(tmpDir, ".lisa");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.yaml"), "provider: claude\n");
		expect(configExists(tmpDir)).toBe(true);
	});
});

describe("loadConfig", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "lisa-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns default config when file does not exist", () => {
		const config = loadConfig(tmpDir);
		expect(config.provider).toBe("");
		expect(config.base_branch).toBe("main");
		expect(config.repos).toEqual([]);
	});

	it("loads and normalizes a valid YAML config", () => {
		const configDir = join(tmpDir, ".lisa");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "config.yaml"),
			`provider: claude
source: linear
source_config:
  team: MyTeam
  project: MyProject
  label: lisa
  pick_from: Todo
  in_progress: In Progress
  done: Done
github: cli
workflow: worktree
workspace: /workspace
base_branch: main
repos: []
loop:
  cooldown: 30
  max_sessions: 5
logs:
  dir: /logs
  format: text
`,
		);

		const config = loadConfig(tmpDir);
		expect(config.provider).toBe("claude");
		expect(config.source).toBe("linear");
		expect(config.source_config.team).toBe("MyTeam");
		expect(config.source_config.project).toBe("MyProject");
		expect(config.loop.cooldown).toBe(30);
		expect(config.models).toEqual(["claude"]);
	});

	it("normalizes old Trello field names", () => {
		const configDir = join(tmpDir, ".lisa");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "config.yaml"),
			`provider: claude
source: trello
source_config:
  board: MyBoard
  list: MyList
  label: lisa
  in_progress: Doing
  done: Done
`,
		);

		const config = loadConfig(tmpDir);
		expect(config.source_config.team).toBe("MyBoard");
		expect(config.source_config.project).toBe("MyList");
		// For Trello, pick_from defaults to project when empty
		expect(config.source_config.pick_from).toBe("MyList");
	});

	it("fills missing base_branch with main", () => {
		const configDir = join(tmpDir, ".lisa");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "config.yaml"),
			`provider: claude
source: linear
source_config:
  team: T
  project: P
  label: l
  pick_from: Todo
  in_progress: IP
  done: D
repos:
  - name: app
    path: ./app
    match: "App:"
`,
		);

		const config = loadConfig(tmpDir);
		expect(config.base_branch).toBe("main");
		expect(config.repos[0]?.base_branch).toBe("main");
	});
});

describe("saveConfig", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "lisa-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("saves config as YAML with correct source_config keys for linear", () => {
		const config: LisaConfig = {
			provider: "claude",
			source: "linear",
			source_config: {
				team: "MyTeam",
				project: "MyProject",
				label: "lisa",
				pick_from: "Todo",
				in_progress: "In Progress",
				done: "Done",
			},
			github: "cli",
			workflow: "worktree",
			workspace: "/workspace",
			base_branch: "main",
			repos: [],
			loop: { cooldown: 0, max_sessions: 0 },
			logs: { dir: "/logs", format: "text" },
		};

		saveConfig(config, tmpDir);

		const content = readFileSync(join(tmpDir, ".lisa", "config.yaml"), "utf-8");
		expect(content).toContain("team: MyTeam");
		expect(content).toContain("project: MyProject");
	});

	it("saves config with Trello-specific keys", () => {
		const config: LisaConfig = {
			provider: "claude",
			source: "trello",
			source_config: {
				team: "MyBoard",
				project: "MyList",
				label: "lisa",
				pick_from: "MyList",
				in_progress: "Doing",
				done: "Done",
			},
			github: "cli",
			workflow: "branch",
			workspace: "/workspace",
			base_branch: "main",
			repos: [],
			loop: { cooldown: 0, max_sessions: 0 },
			logs: { dir: "/logs", format: "text" },
		};

		saveConfig(config, tmpDir);

		const content = readFileSync(join(tmpDir, ".lisa", "config.yaml"), "utf-8");
		expect(content).toContain("board: MyBoard");
		expect(content).not.toContain("team:");
	});
});

describe("mergeWithFlags", () => {
	const baseConfig: LisaConfig = {
		provider: "claude",
		source: "linear",
		source_config: {
			team: "Team",
			project: "Project",
			label: "lisa",
			pick_from: "Todo",
			in_progress: "In Progress",
			done: "Done",
		},
		github: "cli",
		workflow: "worktree",
		workspace: "/workspace",
		base_branch: "main",
		repos: [],
		loop: { cooldown: 0, max_sessions: 0 },
		logs: { dir: "/logs", format: "text" },
	};

	it("overrides provider when flag is set", () => {
		const merged = mergeWithFlags(baseConfig, { provider: "gemini" });
		expect(merged.provider).toBe("gemini");
	});

	it("overrides source when flag is set", () => {
		const merged = mergeWithFlags(baseConfig, { source: "trello" });
		expect(merged.source).toBe("trello");
	});

	it("overrides label in source_config", () => {
		const merged = mergeWithFlags(baseConfig, { label: "custom-label" });
		expect(merged.source_config.label).toBe("custom-label");
	});

	it("overrides github method", () => {
		const merged = mergeWithFlags(baseConfig, { github: "token" });
		expect(merged.github).toBe("token");
	});

	it("does not modify original config", () => {
		mergeWithFlags(baseConfig, { provider: "gemini" });
		expect(baseConfig.provider).toBe("claude");
	});

	it("keeps original values when no flags are provided", () => {
		const merged = mergeWithFlags(baseConfig, {});
		expect(merged.provider).toBe("claude");
		expect(merged.source).toBe("linear");
	});
});
