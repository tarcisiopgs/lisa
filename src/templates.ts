import type { LisaConfig, ProviderName, SourceName, WorkflowMode } from "./types/index.js";

export interface ConfigTemplate {
	id: string;
	label: string;
	hint: string;
	provider: ProviderName;
	source: SourceName;
	workflow: WorkflowMode;
	sourceDefaults: {
		label: string;
		pick_from: string;
		in_progress: string;
		done: string;
	};
}

export const CONFIG_TEMPLATES: ConfigTemplate[] = [
	{
		id: "github-claude",
		label: "GitHub Issues + Claude Code",
		hint: "Most popular setup",
		provider: "claude",
		source: "github-issues",
		workflow: "worktree",
		sourceDefaults: {
			label: "ready",
			pick_from: "open",
			in_progress: "in-progress",
			done: "done",
		},
	},
	{
		id: "linear-claude",
		label: "Linear + Claude Code",
		hint: "Great for fast-moving teams",
		provider: "claude",
		source: "linear",
		workflow: "worktree",
		sourceDefaults: {
			label: "ready",
			pick_from: "Todo",
			in_progress: "In Progress",
			done: "In Review",
		},
	},
	{
		id: "jira-claude",
		label: "Jira + Claude Code",
		hint: "Enterprise-ready",
		provider: "claude",
		source: "jira",
		workflow: "worktree",
		sourceDefaults: {
			label: "ready",
			pick_from: "To Do",
			in_progress: "In Progress",
			done: "In Review",
		},
	},
	{
		id: "github-gemini",
		label: "GitHub Issues + Gemini CLI",
		hint: "Free tier available",
		provider: "gemini",
		source: "github-issues",
		workflow: "worktree",
		sourceDefaults: {
			label: "ready",
			pick_from: "open",
			in_progress: "in-progress",
			done: "done",
		},
	},
	{
		id: "linear-gemini",
		label: "Linear + Gemini CLI",
		hint: "Free tier available",
		provider: "gemini",
		source: "linear",
		workflow: "worktree",
		sourceDefaults: {
			label: "ready",
			pick_from: "Todo",
			in_progress: "In Progress",
			done: "In Review",
		},
	},
];

export function getTemplates(): ConfigTemplate[] {
	return CONFIG_TEMPLATES;
}

export function getTemplateById(id: string): ConfigTemplate | undefined {
	return CONFIG_TEMPLATES.find((t) => t.id === id);
}

export function templateToPartialConfig(template: ConfigTemplate): LisaConfig {
	return {
		provider: template.provider,
		provider_options: {},
		source: template.source,
		source_config: {
			team: "",
			project: "",
			label: template.sourceDefaults.label,
			pick_from: template.sourceDefaults.pick_from,
			in_progress: template.sourceDefaults.in_progress,
			done: template.sourceDefaults.done,
		},
		github: "cli",
		workflow: template.workflow,
		workspace: ".",
		base_branch: "main",
		repos: [],
		loop: { cooldown: 10, max_sessions: 0 },
	};
}
