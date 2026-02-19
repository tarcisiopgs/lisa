import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse, stringify } from "yaml";
import type { LisaConfig } from "./types.js";

const CONFIG_DIR = ".lisa";
const CONFIG_FILE = "config.yaml";

const DEFAULT_CONFIG: LisaConfig = {
	provider: "",
	source: "",
	source_config: {
		team: "",
		project: "",
		label: "",
		initial_status: "",
		active_status: "",
		done_status: "",
	},
	github: "cli",
	workflow: "branch",
	workspace: "",
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
	const parsed = parse(raw) as Partial<LisaConfig>;

	return {
		...DEFAULT_CONFIG,
		...parsed,
		source_config: { ...DEFAULT_CONFIG.source_config, ...parsed.source_config },
		loop: { ...DEFAULT_CONFIG.loop, ...parsed.loop },
		logs: { ...DEFAULT_CONFIG.logs, ...parsed.logs },
	};
}

export function saveConfig(config: LisaConfig, cwd: string = process.cwd()): void {
	const configPath = getConfigPath(cwd);
	const dir = resolve(cwd, CONFIG_DIR);

	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	writeFileSync(configPath, stringify(config), "utf-8");
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
