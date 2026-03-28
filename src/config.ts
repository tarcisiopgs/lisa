import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse, stringify } from "yaml";
import { literal, object, string, union } from "zod";
import type {
	CiMonitorConfig,
	HooksConfig,
	LifecycleConfig,
	LisaConfig,
	OverseerConfig,
	PRPlatform,
	PrConfig,
	ProgressConfig,
	ProofOfWorkConfig,
	ProviderName,
	ReactionsConfig,
	ReconciliationConfig,
	ReviewMonitorConfig,
	SourceConfig,
	SourceName,
	SpecComplianceConfig,
	ValidationCommand,
} from "./types/index.js";

const VALID_PROVIDERS = [
	"claude",
	"gemini",
	"opencode",
	"copilot",
	"cursor",
	"goose",
	"aider",
	"codex",
] as const;
const VALID_SOURCES = [
	"linear",
	"trello",
	"plane",
	"shortcut",
	"gitlab-issues",
	"github-issues",
	"jira",
] as const;
const VALID_PLATFORMS = ["cli", "token", "gitlab", "bitbucket"] as const;
const VALID_WORKFLOWS = ["worktree", "branch"] as const;

/** Schema allows empty strings (partial config) but rejects invalid non-empty values. */
function enumOrEmpty(values: readonly string[]) {
	return union([literal(""), ...values.map((v) => literal(v))] as [
		ReturnType<typeof literal>,
		ReturnType<typeof literal>,
		...ReturnType<typeof literal>[],
	]);
}

const configSchema = object({
	provider: enumOrEmpty(VALID_PROVIDERS),
	source: enumOrEmpty(VALID_SOURCES),
	platform: enumOrEmpty(VALID_PLATFORMS),
	workflow: union(
		VALID_WORKFLOWS.map((w) => literal(w)) as [
			ReturnType<typeof literal>,
			ReturnType<typeof literal>,
			...ReturnType<typeof literal>[],
		],
	),
	base_branch: string().optional(),
	workspace: string().optional(),
}).passthrough();

export class ConfigValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigValidationError";
	}
}

/**
 * Validates critical config fields after assembly.
 * Throws ConfigValidationError with a clear message if validation fails.
 * Skips validation for empty/default configs (e.g., no config file found).
 */
export function validateConfig(config: LisaConfig): void {
	// Skip validation for default/empty configs (no config file loaded)
	if (!config.provider && !config.source) return;

	const result = configSchema.safeParse(config);
	if (!result.success) {
		const issues = result.error.issues.map((issue) => {
			const path = issue.path.join(".");
			if (issue.code === "invalid_union") {
				if (path === "provider")
					return `  provider: "${config.provider}" is not valid. Must be one of: ${VALID_PROVIDERS.join(", ")}`;
				if (path === "source")
					return `  source: "${config.source}" is not valid. Must be one of: ${VALID_SOURCES.join(", ")}`;
				if (path === "platform")
					return `  platform: "${config.platform}" is not valid. Must be one of: ${VALID_PLATFORMS.join(", ")}`;
				if (path === "workflow")
					return `  workflow: "${config.workflow}" is not valid. Must be one of: ${VALID_WORKFLOWS.join(", ")}`;
			}
			return `  ${path}: ${issue.message}`;
		});
		throw new ConfigValidationError(`Invalid configuration:\n${issues.join("\n")}`);
	}

	// Validate models if provider_options has models configured
	if (config.provider && config.provider_options?.[config.provider]?.models) {
		const models = config.provider_options[config.provider]?.models ?? [];
		for (const model of models) {
			if (typeof model !== "string" || !model.trim()) {
				throw new ConfigValidationError(
					`Invalid configuration:\n  provider_options.${config.provider}.models contains an empty or non-string value`,
				);
			}
		}
	}
}

export const DEFAULT_OVERSEER_CONFIG: OverseerConfig = {
	enabled: true,
	check_interval: 30,
	stuck_threshold: 300,
};

const CONFIG_DIR = ".lisa";
const CONFIG_FILE = "config.yaml";

const DEFAULT_CONFIG: LisaConfig = {
	provider: "" as ProviderName,
	provider_options: {} as LisaConfig["provider_options"],
	source: "" as SourceName,
	source_config: {
		scope: "",
		project: "",
		label: "",
		pick_from: "",
		in_progress: "",
		done: "",
	},
	platform: "cli",
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

const USERNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,38}$/;

function isValidPrUsername(s: string): boolean {
	return s === "self" || USERNAME_RE.test(s);
}

function isStringArray(v: unknown): v is string[] {
	return Array.isArray(v) && v.every((item) => typeof item === "string");
}

function parsePrConfig(raw: Partial<PrConfig> | undefined): PrConfig | undefined {
	if (!raw) return undefined;

	const reviewers = isStringArray(raw.reviewers)
		? raw.reviewers.filter(isValidPrUsername)
		: undefined;
	const assignees = isStringArray(raw.assignees)
		? raw.assignees.filter(isValidPrUsername)
		: undefined;

	if (!reviewers?.length && !assignees?.length) return undefined;

	return {
		reviewers: reviewers?.length ? reviewers : undefined,
		assignees: assignees?.length ? assignees : undefined,
	};
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
		scope:
			((rawSource.scope as string) ?? (rawSource.team as string) ?? (rawSource.board as string)) ||
			"",
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
	if (parsed.source === "plane" && !sourceConfig.scope && process.env.PLANE_WORKSPACE) {
		sourceConfig.scope = process.env.PLANE_WORKSPACE;
	}

	// For GitLab Issues, team holds the project path/ID
	if (parsed.source === "gitlab-issues" && !sourceConfig.scope && rawSource.project) {
		sourceConfig.scope = rawSource.project as string;
	}

	// For GitHub Issues, team holds the owner/repo (e.g. "owner/repo")
	if (parsed.source === "github-issues" && !sourceConfig.scope && rawSource.project) {
		sourceConfig.scope = rawSource.project as string;
	}

	// For Jira, team holds the project key
	if (parsed.source === "jira" && !sourceConfig.scope && rawSource.project) {
		sourceConfig.scope = rawSource.project as string;
	}

	// Strip legacy `logs` field from parsed YAML (moved to system cache)
	const { logs: _ignoredLogs, ...parsedWithoutLogs } = parsed as Record<string, unknown>;

	const rawLifecycle = (parsed.lifecycle ?? undefined) as Partial<LifecycleConfig> | undefined;
	const rawHooks = parsed.hooks as Partial<HooksConfig> | undefined;
	const rawProofOfWork = parsed.proof_of_work as
		| Partial<ProofOfWorkConfig & { commands?: unknown[] }>
		| undefined;
	const rawReconciliation = parsed.reconciliation as Partial<ReconciliationConfig> | undefined;
	const rawCiMonitor = parsed.ci_monitor as Partial<CiMonitorConfig> | undefined;
	const rawReviewMonitor = parsed.review_monitor as Partial<ReviewMonitorConfig> | undefined;
	const rawReactions = parsed.reactions as ReactionsConfig | undefined;
	const rawSpecCompliance = parsed.spec_compliance as Partial<SpecComplianceConfig> | undefined;
	const rawProgress = parsed.progress_comments as Partial<ProgressConfig> | undefined;
	const rawPr = parsed.pr as Partial<PrConfig> | undefined;

	const config: LisaConfig = {
		...DEFAULT_CONFIG,
		...(parsedWithoutLogs as Partial<LisaConfig>),
		platform: (parsed.platform ?? parsed.github ?? "cli") as PRPlatform,
		source_config: sourceConfig,
		loop: { ...DEFAULT_CONFIG.loop, ...((parsed.loop ?? {}) as LisaConfig["loop"]) },
		overseer: {
			...DEFAULT_OVERSEER_CONFIG,
			...((parsed.overseer ?? {}) as Partial<OverseerConfig>),
		},
		lifecycle: rawLifecycle
			? {
					mode: rawLifecycle.mode,
					timeout: rawLifecycle.timeout,
				}
			: undefined,
		hooks: rawHooks
			? {
					before_run: rawHooks.before_run,
					after_run: rawHooks.after_run,
					after_create: rawHooks.after_create,
					before_remove: rawHooks.before_remove,
					timeout: rawHooks.timeout,
				}
			: undefined,
		proof_of_work: rawProofOfWork
			? {
					enabled: rawProofOfWork.enabled ?? false,
					commands: Array.isArray(rawProofOfWork.commands)
						? (rawProofOfWork.commands as ValidationCommand[])
						: [],
					max_retries: rawProofOfWork.max_retries,
					timeout: rawProofOfWork.timeout,
					block_on_failure: rawProofOfWork.block_on_failure,
				}
			: undefined,
		reconciliation: rawReconciliation
			? {
					enabled: rawReconciliation.enabled ?? false,
					check_interval: rawReconciliation.check_interval,
				}
			: undefined,
		ci_monitor: rawCiMonitor
			? {
					enabled: rawCiMonitor.enabled ?? false,
					max_retries: rawCiMonitor.max_retries,
					poll_interval: rawCiMonitor.poll_interval,
					poll_timeout: rawCiMonitor.poll_timeout,
					block_on_failure: rawCiMonitor.block_on_failure,
				}
			: undefined,
		review_monitor: rawReviewMonitor
			? {
					enabled: rawReviewMonitor.enabled ?? false,
					max_retries: rawReviewMonitor.max_retries,
					poll_interval: rawReviewMonitor.poll_interval,
					poll_timeout: rawReviewMonitor.poll_timeout,
					block_on_failure: rawReviewMonitor.block_on_failure,
				}
			: undefined,
		reactions: rawReactions ?? undefined,
		spec_compliance: rawSpecCompliance
			? {
					enabled: rawSpecCompliance.enabled ?? false,
					max_retries: rawSpecCompliance.max_retries,
					block_on_failure: rawSpecCompliance.block_on_failure,
				}
			: undefined,
		progress_comments: rawProgress ? { enabled: rawProgress.enabled ?? false } : undefined,
		pr: parsePrConfig(rawPr),
		provider_options: {
			...(DEFAULT_CONFIG.provider_options || {}),
			...((parsed.provider_options ?? {}) as LisaConfig["provider_options"]),
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

	validateConfig(config);

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
					board: sc.scope,
					pick_from: sc.pick_from || sc.project,
					label: sc.label,
					...removeLabelEntry,
					in_progress: sc.in_progress,
					done: sc.done,
				}
			: config.source === "gitlab-issues"
				? {
						scope: sc.scope,
						label: sc.label,
						...removeLabelEntry,
						in_progress: sc.in_progress,
						done: sc.done,
					}
				: config.source === "github-issues"
					? {
							scope: sc.scope,
							label: sc.label,
							...removeLabelEntry,
							in_progress: sc.in_progress,
							done: sc.done,
						}
					: config.source === "jira"
						? {
								scope: sc.scope,
								label: sc.label,
								...removeLabelEntry,
								pick_from: sc.pick_from,
								in_progress: sc.in_progress,
								done: sc.done,
							}
						: {
								scope: sc.scope,
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
	if (flags.platform) merged.platform = flags.platform;
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
