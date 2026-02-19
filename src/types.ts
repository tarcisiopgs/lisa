export type GitHubMethod = "cli" | "token";
export type SourceName = "linear" | "trello";
export type ProviderName = "claude" | "gemini" | "opencode";
export type LogFormat = "text" | "json";
export type WorkflowMode = "worktree" | "branch";

export interface RepoConfig {
	name: string;
	path: string;
	match: string;
}

export interface SourceConfig {
	team: string;
	project: string;
	label: string;
	initial_status: string;
	active_status: string;
	done_status: string;
}

export interface LoopConfig {
	cooldown: number;
	max_sessions: number;
}

export interface LogsConfig {
	dir: string;
	format: LogFormat;
}

export interface LisaConfig {
	provider: ProviderName;
	source: SourceName;
	source_config: SourceConfig;
	github: GitHubMethod;
	workflow: WorkflowMode;
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
}

export interface Source {
	name: SourceName;
	fetchNextIssue(config: SourceConfig): Promise<Issue | null>;
	updateStatus(issueId: string, status: string): Promise<void>;
	removeLabel(issueId: string, label: string): Promise<void>;
	attachPullRequest(issueId: string, prUrl: string): Promise<void>;
}
