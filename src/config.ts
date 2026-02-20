import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse, stringify } from "yaml";
import type { LisaConfig, SourceConfig } from "./types.js";

const CONFIG_DIR = ".lisa";
const CONFIG_FILE = "config.yaml";

const DEFAULT_CONFIG: LisaConfig = {
	provider: "",
	source: "",
	source_config: {
		team: "",
		project: "",
		label: "",
		pick_from: "",
		in_progress: "",
		done: "",
	},
	github: "cli",
	workflow: "branch",
	workspace: "",
	base_branch: "main",
	repos: [],
	loop: {
		cooldown: 0,
		max_sessions: 0,
	},
	logs: {
		dir: "",
		format: "",
	},
};

export function getConfigPath(cwd: string = process.cwd()): string {
	return resolve(cwd, CONFIG_DIR, CONFIG_FILE);
}

export function configExists(cwd: string = process.cwd()): boolean {
	return existsSync(getConfigPath(cwd));
}

export function loadConfig(cwd: string = process.cwd()): LisaConfig {
	const configPath = getConfigPath(cwd);

	if (!existsSync(configPath)) {
		return { ...DEFAULT_CONFIG };
	}

	const raw = readFileSync(configPath, "utf-8");
	const parsed = parse(raw) as Record<string, unknown>;

	// Normalize source_config from any format (old or new, linear or trello)
	const rawSource = (parsed.source_config ?? {}) as Record<string, string>;
	const sourceConfig: SourceConfig = {
		team: rawSource.team ?? rawSource.board ?? "",
		project: rawSource.project ?? rawSource.list ?? rawSource.pick_from ?? "",
		label: rawSource.label ?? "",
		pick_from: rawSource.pick_from ?? rawSource.initial_status ?? "",
		in_progress: rawSource.in_progress ?? rawSource.active_status ?? "",
		done: rawSource.done ?? rawSource.done_status ?? "",
	};

	// For Trello, pick_from defaults to project (source list)
	if (parsed.source === "trello" && !sourceConfig.pick_from) {
		sourceConfig.pick_from = sourceConfig.project;
	}

	const config: LisaConfig = {
		...DEFAULT_CONFIG,
		...(parsed as Partial<LisaConfig>),
		source_config: sourceConfig,
		loop: { ...DEFAULT_CONFIG.loop, ...((parsed.loop ?? {}) as LisaConfig["loop"]) },
		logs: { ...DEFAULT_CONFIG.logs, ...((parsed.logs ?? {}) as LisaConfig["logs"]) },
	};

	// Backward compat: fill base_branch if missing
	if (!config.base_branch) config.base_branch = "main";
	for (const repo of config.repos) {
		if (!repo.base_branch) repo.base_branch = config.base_branch;
	}

	// Backward compat: if models is not set, derive from provider
	if (!config.models && config.provider) {
		config.models = [config.provider];
	}

	return config;
}

export function saveConfig(config: LisaConfig, cwd: string = process.cwd()): void {
	const configPath = getConfigPath(cwd);
	const dir = resolve(cwd, CONFIG_DIR);

	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	// Build source-specific YAML keys
	const sc = config.source_config;
	const sourceYaml =
		config.source === "trello"
			? {
					board: sc.team,
					pick_from: sc.pick_from || sc.project,
					label: sc.label,
					in_progress: sc.in_progress,
					done: sc.done,
				}
			: {
					team: sc.team,
					project: sc.project,
					label: sc.label,
					pick_from: sc.pick_from,
					in_progress: sc.in_progress,
					done: sc.done,
				};

	const output = { ...config, source_config: sourceYaml };
	writeFileSync(configPath, stringify(output), "utf-8");
}

export function mergeWithFlags(
	config: LisaConfig,
	flags: Partial<LisaConfig> & { label?: string },
): LisaConfig {
	const merged = { ...config };

	if (flags.provider) merged.provider = flags.provider;
	if (flags.source) merged.source = flags.source;
	if (flags.github) merged.github = flags.github;
	if (flags.label) merged.source_config = { ...merged.source_config, label: flags.label };

	return merged;
}
