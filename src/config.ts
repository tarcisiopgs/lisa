import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse, stringify } from "yaml";
import type { MatutoConfig } from "./types.js";

const CONFIG_DIR = ".matuto";
const CONFIG_FILE = "config.yaml";

const DEFAULT_CONFIG: MatutoConfig = {
	provider: "claude",
	model: "claude-sonnet-4-6",
	effort: "medium",
	source: "linear",
	source_config: {
		team: "Internal",
		project: "Zenixx",
		label: "ready",
		status: "Backlog",
	},
	workspace: ".",
	repos: [],
	loop: {
		cooldown: 10,
		max_sessions: 0,
	},
	logs: {
		dir: ".matuto/logs",
		format: "text",
	},
};

export function getConfigPath(cwd: string = process.cwd()): string {
	return resolve(cwd, CONFIG_DIR, CONFIG_FILE);
}

export function configExists(cwd: string = process.cwd()): boolean {
	return existsSync(getConfigPath(cwd));
}

export function loadConfig(cwd: string = process.cwd()): MatutoConfig {
	const configPath = getConfigPath(cwd);

	if (!existsSync(configPath)) {
		return { ...DEFAULT_CONFIG };
	}

	const raw = readFileSync(configPath, "utf-8");
	const parsed = parse(raw) as Partial<MatutoConfig>;

	return {
		...DEFAULT_CONFIG,
		...parsed,
		source_config: { ...DEFAULT_CONFIG.source_config, ...parsed.source_config },
		loop: { ...DEFAULT_CONFIG.loop, ...parsed.loop },
		logs: { ...DEFAULT_CONFIG.logs, ...parsed.logs },
	};
}

export function saveConfig(config: MatutoConfig, cwd: string = process.cwd()): void {
	const configPath = getConfigPath(cwd);
	const dir = resolve(cwd, CONFIG_DIR);

	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	writeFileSync(configPath, stringify(config), "utf-8");
}

export function mergeWithFlags(
	config: MatutoConfig,
	flags: Partial<MatutoConfig> & { label?: string },
): MatutoConfig {
	const merged = { ...config };

	if (flags.provider) merged.provider = flags.provider;
	if (flags.model) merged.model = flags.model;
	if (flags.effort) merged.effort = flags.effort;
	if (flags.source) merged.source = flags.source;
	if (flags.label) merged.source_config = { ...merged.source_config, label: flags.label };

	return merged;
}
