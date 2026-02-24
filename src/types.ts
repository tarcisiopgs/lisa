export type GitHubMethod = "cli" | "token";
export type SourceName = "linear" | "trello" | "gitlab-issues" | "jira";
export type ProviderName = "claude" | "gemini" | "opencode" | "copilot" | "cursor" | "goose";
export type LogFormat = "text" | "json";
export type WorkflowMode = "worktree" | "branch";

export interface ResourceConfig {
	name: string;
	check_port: number;
	up: string;
	down: string;
	startup_timeout: number;
	cwd?: string;
}

export interface LifecycleConfig {
	resources: ResourceConfig[];
	setup: string[];
}

export interface RepoConfig {
	name: string;
	path: string;
	match: string;
	base_branch: string;
	lifecycle?: LifecycleConfig;
}

export interface SourceConfig {
	team: string;
	project: string;
	label: string;
	pick_from: string;
	in_progress: string;
	done: string;
}

export interface LoopConfig {
	cooldown: number;
	max_sessions: number;
}

export interface OverseerConfig {
	enabled: boolean;
	check_interval: number;
	stuck_threshold: number;
}

export interface LogsConfig {
	dir: string;
	format: LogFormat;
}

export interface LisaConfig {
	provider: ProviderName;
	models?: string[];
	source: SourceName;
	source_config: SourceConfig;
	github: GitHubMethod;
	workflow: WorkflowMode;
	workspace: string;
	base_branch: string;
	repos: RepoConfig[];
	loop: LoopConfig;
	logs: LogsConfig;
	overseer?: OverseerConfig;
}

export interface Issue {
	id: string;
	title: string;
	description: string;
	url: string;
	repo?: string;
}

export interface ModelSpec {
	provider: ProviderName;
	model?: string; // undefined = use provider's default model
}

export interface RunOptions {
	logFile: string;
	cwd: string;
	guardrailsDir?: string;
	issueId?: string;
	overseer?: OverseerConfig;
	useNativeWorktree?: boolean;
	model?: string; // model name to pass to the provider CLI
}

export interface RunResult {
	success: boolean;
	output: string;
	duration: number;
}

export interface Provider {
	name: ProviderName;
	supportsNativeWorktree?: boolean;
	isAvailable(): Promise<boolean>;
	run(prompt: string, opts: RunOptions): Promise<RunResult>;
}

export interface ModelAttempt {
	provider: string;
	model?: string;
	success: boolean;
	error?: string;
	duration: number;
}

export interface FallbackResult {
	success: boolean;
	output: string;
	duration: number;
	providerUsed: string;
	provider?: Provider;
	attempts: ModelAttempt[];
}

export interface PlanStep {
	repoPath: string;
	scope: string;
	order: number;
}

export interface ExecutionPlan {
	steps: PlanStep[];
}

export interface Source {
	name: SourceName;
	fetchNextIssue(config: SourceConfig): Promise<Issue | null>;
	fetchIssueById(id: string): Promise<Issue | null>;
	updateStatus(issueId: string, status: string): Promise<void>;
	removeLabel(issueId: string, label: string): Promise<void>;
	attachPullRequest(issueId: string, prUrl: string): Promise<void>;
	completeIssue(issueId: string, status: string, labelToRemove?: string): Promise<void>;
}
