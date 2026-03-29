import type { ProjectContext } from "../context.js";
import type { DependencyContext, Issue, LisaConfig, PlanStep, PRPlatform } from "../types/index.js";

export type TestRunner = "vitest" | "jest" | null;
export type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

export type PromptVariant = "worktree" | "native-worktree" | "branch" | "scoped";

export interface BuildPromptOptions {
	issue: Issue;
	variant: PromptVariant;
	testRunner?: TestRunner;
	pm?: PackageManager;
	baseBranch?: string;
	projectContext?: ProjectContext;
	manifestPath?: string;
	cwd?: string;
	platform?: PRPlatform;
	repoContextMd?: string | null;
	/** Branch mode only: resolved config for repo entries */
	config?: LisaConfig;
	/** Scoped mode only */
	step?: PlanStep;
	/** Scoped mode only */
	previousResults?: PreviousStepResult[];
	/** Scoped mode only */
	isLastStep?: boolean;
	/** Context enrichment: relevant files discovered by grepping the codebase */
	relevantFiles?: string | null;
	/** Lineage context for plan-decomposed issues */
	lineageBlock?: string | null;
}

export interface PreviousStepResult {
	repoPath: string;
	branch: string;
	prUrl?: string;
}

export interface ContinuationPromptOptions {
	issue: { id: string; title: string };
	diffStat: string;
	previousOutput: string;
	platform: PRPlatform;
	baseBranch: string;
	manifestPath: string;
}
