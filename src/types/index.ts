export type PRPlatform = "cli" | "token" | "gitlab" | "bitbucket";
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

export interface ProviderOptions {
	/** Single model override (legacy, prefer models[]) */
	model?: string;
	/** Ordered list of models to try (first = primary, rest = fallbacks) */
	models?: string[];
	/** Claude-specific: reasoning effort level */
	effort?: string;
	/** Goose-specific: underlying LLM provider (e.g. "gemini-cli") */
	goose_provider?: string;
}

export interface RepoConfig {
	name: string;
	path: string;
	match: string;
	base_branch: string;
}

export interface SourceConfig {
	scope: string;
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
	session_timeout?: number; // seconds per provider run, 0 = disabled (default)
	output_stall_timeout?: number; // seconds without stdout before killing provider (default: 120, 0 = disabled)
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

export interface HooksConfig {
	before_run?: string;
	after_run?: string;
	after_create?: string;
	before_remove?: string;
	timeout?: number; // ms, default 60000
}

export interface ValidationCommand {
	name: string;
	run: string;
}

export interface ProofOfWorkConfig {
	enabled?: boolean;
	commands: ValidationCommand[];
	max_retries?: number; // default: 2
	timeout?: number; // ms per command, default: 120000
}

export interface ValidationResult {
	name: string;
	success: boolean;
	output: string;
	duration: number; // ms
}

export interface ReconciliationConfig {
	enabled: boolean;
	check_interval?: number; // seconds, default: 30
}

export interface LisaConfig {
	provider: ProviderName;
	provider_options?: Partial<Record<ProviderName, ProviderOptions>>;
	bell?: boolean;
	source: SourceName;
	source_config: SourceConfig;
	platform: PRPlatform;
	workflow: WorkflowMode;
	workspace: string;
	base_branch: string;
	repos: RepoConfig[];
	loop: LoopConfig;
	overseer?: OverseerConfig;
	validation?: ValidationConfig;
	lifecycle?: LifecycleConfig;
	hooks?: HooksConfig;
	proof_of_work?: ProofOfWorkConfig;
	reconciliation?: ReconciliationConfig;
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
	status?: string;
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
	sessionTimeout?: number; // seconds per provider run, 0 = disabled
	outputStallTimeout?: number; // seconds without stdout before killing provider (default: 120, 0 = disabled)
	useNativeWorktree?: boolean;
	model?: string; // model name to pass to the provider CLI
	providerOptions?: { effort?: string }; // provider-specific options (e.g. Claude --effort)
	env?: Record<string, string>; // additional env vars to inject into the provider process
	onProcess?: (pid: number) => void; // called when the provider spawns its child process
	shouldAbort?: () => boolean; // checked between fallback attempts to stop the chain early
	earlySuccess?: () => boolean; // if true after a failed attempt, treat the run as successful (e.g. plan file already written)
}

export interface RunResult {
	success: boolean;
	output: string;
	duration: number;
	exitCode?: number;
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

export interface CreateIssueOpts {
	title: string;
	description: string;
	status: string;
	label: string | string[];
	order?: number;
	parentId?: string;
}

export interface PlannedIssue {
	title: string;
	description: string;
	acceptanceCriteria: string[];
	relevantFiles: string[];
	order: number;
	dependsOn: number[];
	repo?: string;
}

export interface ChatMessage {
	role: "user" | "ai";
	content: string;
}

export interface PlanResult {
	goal: string;
	sourceIssueId?: string;
	issues: PlannedIssue[];
	createdAt: string;
	status: "draft" | "approved" | "created";
	createdIssueIds?: string[];
	brainstormHistory?: ChatMessage[];
}

export interface Source {
	name: SourceName;
	fetchNextIssue(config: SourceConfig): Promise<Issue | null>;
	fetchIssueById(id: string): Promise<Issue | null>;
	updateStatus(issueId: string, status: string, config?: SourceConfig): Promise<void>;
	removeLabel(issueId: string, label: string): Promise<void>;
	addLabel?(issueId: string, label: string): Promise<void>;
	attachPullRequest(issueId: string, prUrl: string): Promise<void>;
	completeIssue(
		issueId: string,
		status: string,
		labelToRemove?: string,
		config?: SourceConfig,
	): Promise<void>;
	listIssues(config: SourceConfig): Promise<Issue[]>;

	// Plan mode — issue creation + dependency linking
	createIssue?(opts: CreateIssueOpts, config: SourceConfig): Promise<string>;
	linkDependency?(issueId: string, dependsOnId: string): Promise<void>;

	// Wizard helpers — optional, used by lisa init to present select options
	listScopes?(): Promise<{ value: string; label: string }[]>;
	listProjects?(scope: string): Promise<{ value: string; label: string }[]>;
	listLabels?(scope: string, project?: string): Promise<{ value: string; label: string }[]>;
	listStatuses?(scope: string, project?: string): Promise<{ value: string; label: string }[]>;
}
