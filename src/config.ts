import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse, stringify } from "yaml";
import type {
	LifecycleConfig,
	LisaConfig,
	OverseerConfig,
	ProviderName,
	SourceConfig,
	SourceName,
	TelemetryConfig,
} from "./types/index.js";

export const DEFAULT_OVERSEER_CONFIG: OverseerConfig = {
	enabled: false,
	check_interval: 30,
	stuck_threshold: 300,
};

const CONFIG_DIR = ".lisa";
const CONFIG_FILE = "config.yaml";

const DEFAULT_CONFIG: LisaConfig = {
	provider: "" as ProviderName,
	provider_options: {} as Partial<Record<ProviderName, { model?: string; models?: string[] }>>,
	source: "" as SourceName,
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
	overseer: { ...DEFAULT_OVERSEER_CONFIG },
};

export function getConfigPath(cwd: string = process.cwd()): string {
	return resolve(cwd, CONFIG_DIR, CONFIG_FILE);
}

export function configExists(cwd: string = process.cwd()): boolean {
	return existsSync(getConfigPath(cwd));
}

export function findConfigDir(startDir: string = process.cwd()): string | null {
	let dir = startDir;
	while (true) {
		if (existsSync(getConfigPath(dir))) return dir;
		const parent = resolve(dir, "..");
		if (parent === dir) return null; // filesystem root
		dir = parent;
	}
}

export function loadConfig(cwd: string = process.cwd()): LisaConfig {
	const configPath = getConfigPath(cwd);

	if (!existsSync(configPath)) {
		return { ...DEFAULT_CONFIG };
	}

	const raw = readFileSync(configPath, "utf-8");
	const parsed = parse(raw) as Record<string, unknown>;

	// Normalize source_config from any format (old or new, linear or trello)
	const rawSource = (parsed.source_config ?? {}) as Record<string, unknown>;
	const rawLabel = rawSource.label;
	const label: string | string[] = Array.isArray(rawLabel)
		? (rawLabel as string[])
		: typeof rawLabel === "string"
			? rawLabel
			: "";
	const sourceConfig: SourceConfig = {
		team: ((rawSource.team as string) ?? (rawSource.board as string)) || "",
		project:
			((rawSource.project as string) ??
				(rawSource.list as string) ??
				(rawSource.pick_from as string)) ||
			"",
		label,
		remove_label: (rawSource.remove_label as string) || undefined,
		pick_from: ((rawSource.pick_from as string) ?? (rawSource.initial_status as string)) || "",
		in_progress: ((rawSource.in_progress as string) ?? (rawSource.active_status as string)) || "",
		done: ((rawSource.done as string) ?? (rawSource.done_status as string)) || "",
	};

	// For Trello, pick_from defaults to project (source list)
	if (parsed.source === "trello" && !sourceConfig.pick_from) {
		sourceConfig.pick_from = sourceConfig.project;
	}

	// For Plane, team holds the workspace slug; fall back to PLANE_WORKSPACE env var
	if (parsed.source === "plane" && !sourceConfig.team && process.env.PLANE_WORKSPACE) {
		sourceConfig.team = process.env.PLANE_WORKSPACE;
	}

	// For GitLab Issues, team holds the project path/ID
	if (parsed.source === "gitlab-issues" && !sourceConfig.team && rawSource.project) {
		sourceConfig.team = rawSource.project as string;
	}

	// For GitHub Issues, team holds the owner/repo (e.g. "owner/repo")
	if (parsed.source === "github-issues" && !sourceConfig.team && rawSource.project) {
		sourceConfig.team = rawSource.project as string;
	}

	// For Jira, team holds the project key
	if (parsed.source === "jira" && !sourceConfig.team && rawSource.project) {
		sourceConfig.team = rawSource.project as string;
	}

	// Strip legacy `logs` field from parsed YAML (moved to system cache)
	const { logs: _ignoredLogs, ...parsedWithoutLogs } = parsed as Record<string, unknown>;

	const rawTelemetry = (parsed.telemetry ?? {}) as Partial<TelemetryConfig>;
	const rawLifecycle = (parsed.lifecycle ?? undefined) as Partial<LifecycleConfig> | undefined;
	const config: LisaConfig = {
		...DEFAULT_CONFIG,
		...(parsedWithoutLogs as Partial<LisaConfig>),
		source_config: sourceConfig,
		loop: { ...DEFAULT_CONFIG.loop, ...((parsed.loop ?? {}) as LisaConfig["loop"]) },
		overseer: {
			...DEFAULT_OVERSEER_CONFIG,
			...((parsed.overseer ?? {}) as Partial<OverseerConfig>),
		},
		telemetry:
			Object.keys(rawTelemetry).length > 0 ? { enabled: rawTelemetry.enabled ?? false } : undefined,
		lifecycle: rawLifecycle
			? {
					mode: rawLifecycle.mode,
					timeout: rawLifecycle.timeout,
				}
			: undefined,
		provider_options: {
			...(DEFAULT_CONFIG.provider_options || {}),
			...((parsed.provider_options ?? {}) as Partial<
				Record<ProviderName, { model?: string; models?: string[] }>
			>),
		},
	};

	// Backward compat: fill base_branch if missing
	if (!config.base_branch) config.base_branch = "main";
	for (const repo of config.repos) {
		if (!repo.base_branch) repo.base_branch = config.base_branch;
	}

	// Ensure provider_options for the current provider exists
	if (!config.provider_options) {
		config.provider_options = {};
	}
	if (!config.provider_options[config.provider]) {
		config.provider_options[config.provider] = {};
	}

	// Backward compat: if old top-level `models` exists, migrate it
	if (parsed.models && Array.isArray(parsed.models)) {
		config.provider_options[config.provider] = {
			...config.provider_options[config.provider],
			models: parsed.models as string[],
		};
	}

	// If provider has no models configured, default to [provider]
	if (!config.provider_options[config.provider]?.models?.length && config.provider) {
		config.provider_options[config.provider] = {
			...config.provider_options[config.provider],
			models: [config.provider],
		};
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
	const removeLabelEntry = sc.remove_label ? { remove_label: sc.remove_label } : {};
	const sourceYaml =
		config.source === "trello"
			? {
					board: sc.team,
					pick_from: sc.pick_from || sc.project,
					label: sc.label,
					...removeLabelEntry,
					in_progress: sc.in_progress,
					done: sc.done,
				}
			: config.source === "gitlab-issues"
				? {
						team: sc.team,
						label: sc.label,
						...removeLabelEntry,
						in_progress: sc.in_progress,
						done: sc.done,
					}
				: config.source === "github-issues"
					? {
							team: sc.team,
							label: sc.label,
							...removeLabelEntry,
							in_progress: sc.in_progress,
							done: sc.done,
						}
					: config.source === "jira"
						? {
								team: sc.team,
								label: sc.label,
								...removeLabelEntry,
								pick_from: sc.pick_from,
								in_progress: sc.in_progress,
								done: sc.done,
							}
						: {
								team: sc.team,
								project: sc.project,
								label: sc.label,
								...removeLabelEntry,
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
	if (flags.bell !== undefined) merged.bell = flags.bell;
	if (flags.lifecycle) {
		merged.lifecycle = { ...merged.lifecycle, ...flags.lifecycle };
	}
	if (flags.label) {
		const parts = flags.label
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		const label = parts.length === 1 ? (parts[0] as string) : parts;
		merged.source_config = { ...merged.source_config, label };
	}

	return merged;
}

/**
 * Returns the label to remove on issue completion.
 * - If remove_label is set, use it.
 * - If label is a single string, use it (backward compat).
 * - If label is an array without remove_label, returns undefined.
 */
export function getRemoveLabel(sc: SourceConfig): string | undefined {
	if (sc.remove_label) return sc.remove_label;
	if (typeof sc.label === "string" && sc.label) return sc.label;
	return undefined;
}

/**
 * Returns the label(s) as an array, normalizing from string or string[].
 */
export function getLabelsArray(sc: SourceConfig): string[] {
	if (Array.isArray(sc.label)) return sc.label;
	return sc.label ? [sc.label] : [];
}

/**
 * Returns a display string for the label(s).
 */
export function formatLabels(sc: SourceConfig): string {
	const labels = getLabelsArray(sc);
	return labels.length === 0 ? "(none)" : labels.join(", ");
}
