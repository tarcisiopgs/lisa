export type GitHubMethod = "cli" | "token" | "gitlab" | "bitbucket";
export type SourceName =
	| "linear"
	| "trello"
	| "plane"
	| "shortcut"
	| "gitlab-issues"
	| "github-issues"
	| "jira";
export type ProviderName =
	| "claude"
	| "gemini"
	| "opencode"
	| "copilot"
	| "cursor"
	| "goose"
	| "aider"
	| "codex";
export type WorkflowMode = "worktree" | "branch";

export interface RepoConfig {
	name: string;
	path: string;
	match: string;
	base_branch: string;
}

export interface SourceConfig {
	team: string;
	project: string;
	label: string | string[];
	remove_label?: string;
	pick_from: string;
	in_progress: string;
	done: string;
}

export interface LoopConfig {
	cooldown: number;
	max_sessions: number;
	concurrency?: number;
}

export interface OverseerConfig {
	enabled: boolean;
	check_interval: number;
	stuck_threshold: number;
}

export interface ValidationConfig {
	require_acceptance_criteria?: boolean;
}

export type LifecycleMode = "auto" | "skip" | "validate-only";

export interface LifecycleConfig {
	mode?: LifecycleMode; // default: "auto"
	timeout?: number; // seconds per resource, default: 30
}

export interface TelemetryConfig {
	enabled: boolean;
}

export interface LisaConfig {
	provider: ProviderName;
	provider_options?: Partial<Record<ProviderName, { model?: string; models?: string[] }>>;
	bell?: boolean;
	source: SourceName;
	source_config: SourceConfig;
	github: GitHubMethod;
	workflow: WorkflowMode;
	workspace: string;
	base_branch: string;
	repos: RepoConfig[];
	loop: LoopConfig;
	overseer?: OverseerConfig;
	validation?: ValidationConfig;
	lifecycle?: LifecycleConfig;
	telemetry?: TelemetryConfig;
}

export interface DependencyContext {
	issueId: string;
	branch: string;
	prUrl: string;
	changedFiles: string[];
}

export interface Issue {
	id: string;
	title: string;
	description: string;
	url: string;
	repo?: string;
	dependency?: DependencyContext;
	completedBlockerIds?: string[];
	specWarning?: string;
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
	env?: Record<string, string>; // additional env vars to inject into the provider process
	onProcess?: (pid: number) => void; // called when the provider spawns its child process
	shouldAbort?: () => boolean; // checked between fallback attempts to stop the chain early
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
	addLabel?(issueId: string, label: string): Promise<void>;
	attachPullRequest(issueId: string, prUrl: string): Promise<void>;
	completeIssue(issueId: string, status: string, labelToRemove?: string): Promise<void>;
	listIssues(config: SourceConfig): Promise<Issue[]>;
}
