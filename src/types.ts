export type Effort = "low" | "medium" | "high";
export type SourceName = "linear" | "trello" | "local";
export type ProviderName = "claude" | "gemini" | "opencode";
export type LogFormat = "text" | "json";

export interface RepoConfig {
	name: string;
	path: string;
	match: string;
}

export interface SourceConfig {
	team: string;
	project: string;
	label: string;
	status: string;
}

export interface LoopConfig {
	cooldown: number;
	max_sessions: number;
}

export interface LogsConfig {
	dir: string;
	format: LogFormat;
}

export interface MatutoConfig {
	provider: ProviderName;
	model?: string;
	effort?: Effort;
	source: SourceName;
	source_config: SourceConfig;
	workspace: string;
	repos: RepoConfig[];
	loop: LoopConfig;
	logs: LogsConfig;
}

export interface Issue {
	id: string;
	title: string;
	description: string;
	url: string;
	repo?: string;
}

export interface RunOptions {
	model: string;
	effort: Effort;
	logFile: string;
	cwd: string;
}

export interface RunResult {
	success: boolean;
	output: string;
	duration: number;
}

export interface Provider {
	name: ProviderName;
	isAvailable(): Promise<boolean>;
	run(prompt: string, opts: RunOptions): Promise<RunResult>;
	pickIssue(source: Source, config: MatutoConfig): Promise<string | null>;
}

export interface Source {
	name: SourceName;
	buildFetchPrompt(config: SourceConfig): string;
	buildUpdatePrompt(issueId: string, status: string): string;
	buildRemoveLabelPrompt(issueId: string, label: string): string;
	parseIssueId(output: string): string | null;
	fetchNextLocal?(cwd: string): Promise<Issue | null>;
	markDone?(issueId: string, cwd: string): Promise<void>;
}
