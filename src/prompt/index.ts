import { resolve } from "node:path";
import type { ProjectContext } from "../context.js";
import { getManifestPath } from "../paths.js";
import type { Issue, LisaConfig, PlanStep, PRPlatform } from "../types/index.js";
import { buildBranchInstructions } from "./branch.js";
import { buildNativeWorktreeInstructions } from "./native-worktree.js";
import { buildScopedInstructions } from "./scoped.js";
import type {
	BuildPromptOptions,
	PackageManager,
	PreviousStepResult,
	TestRunner,
} from "./types.js";
import { buildWorktreeInstructions } from "./worktree.js";

export { buildContinuationPrompt } from "./continuation.js";
export { buildPlanningPrompt } from "./planning.js";
export {
	buildContextMdBlock,
	buildDefinitionOfDone,
	buildDependencyContext,
	buildTaskTypeHint,
	detectPackageManager,
	detectTestRunner,
	extractReadmeHeadings,
	GUARDRAILS_PLACEHOLDER,
} from "./shared.js";
// Re-export all public API
export type {
	BuildPromptOptions,
	ContinuationPromptOptions,
	PackageManager,
	PreviousStepResult,
	PromptVariant,
	TestRunner,
} from "./types.js";

export function buildPrompt(opts: BuildPromptOptions): string {
	const {
		issue,
		variant,
		testRunner,
		pm,
		baseBranch,
		projectContext,
		cwd,
		platform = "cli",
		repoContextMd,
		config,
		step,
		previousResults = [],
		isLastStep = false,
		relevantFiles,
		lineageBlock,
	} = opts;

	// Resolve manifest path
	let manifestPath = opts.manifestPath;
	if (!manifestPath && variant === "branch" && config) {
		manifestPath = getManifestPath(resolve(config.workspace));
	}

	switch (variant) {
		case "worktree":
			return buildWorktreeInstructions({
				issue,
				testRunner: testRunner ?? null,
				pm: pm ?? "npm",
				baseBranch,
				projectContext,
				manifestPath,
				cwd,
				platform,
				repoContextMd: repoContextMd ?? null,
				relevantFiles: relevantFiles ?? null,
				lineageBlock: lineageBlock ?? null,
			});

		case "native-worktree":
			return buildNativeWorktreeInstructions({
				issue,
				testRunner: testRunner ?? null,
				pm: pm ?? "npm",
				baseBranch,
				projectContext,
				manifestPath,
				cwd,
				platform,
				repoContextMd: repoContextMd ?? null,
				relevantFiles: relevantFiles ?? null,
				lineageBlock: lineageBlock ?? null,
			});

		case "branch": {
			if (!config) {
				throw new Error("Branch variant requires config");
			}
			return buildBranchInstructions({
				issue,
				testRunner: testRunner ?? null,
				pm: pm ?? "npm",
				baseBranch,
				projectContext,
				manifestPath,
				cwd,
				platform,
				repoContextMd: repoContextMd ?? null,
				config,
				relevantFiles: relevantFiles ?? null,
				lineageBlock: lineageBlock ?? null,
			});
		}

		case "scoped": {
			if (!step) {
				throw new Error("Scoped variant requires step");
			}
			return buildScopedInstructions({
				issue,
				testRunner: testRunner ?? null,
				pm: pm ?? "npm",
				baseBranch,
				projectContext,
				manifestPath,
				cwd,
				platform,
				repoContextMd: repoContextMd ?? null,
				step,
				previousResults,
				isLastStep,
				relevantFiles: relevantFiles ?? null,
				lineageBlock: lineageBlock ?? null,
			});
		}
	}
}

export function buildImplementPrompt(
	issue: Issue,
	config: LisaConfig,
	testRunner?: TestRunner,
	pm?: PackageManager,
	projectContext?: ProjectContext,
	cwd?: string,
	manifestPath?: string,
	repoContextMd?: string | null,
	relevantFiles?: string | null,
	lineageBlock?: string | null,
): string {
	const workspace = resolve(config.workspace);
	const resolvedManifestPath = manifestPath ?? getManifestPath(workspace);

	if (config.workflow === "worktree") {
		return buildPrompt({
			issue,
			variant: "worktree",
			testRunner,
			pm,
			baseBranch: config.base_branch,
			projectContext,
			manifestPath: resolvedManifestPath,
			cwd,
			platform: config.platform,
			repoContextMd,
			relevantFiles,
			lineageBlock,
		});
	}

	return buildPrompt({
		issue,
		variant: "branch",
		testRunner,
		pm,
		baseBranch: config.base_branch,
		projectContext,
		manifestPath: resolvedManifestPath,
		cwd,
		platform: config.platform,
		repoContextMd,
		config,
		relevantFiles,
		lineageBlock,
	});
}

export function buildNativeWorktreePrompt(
	issue: Issue,
	repoPath?: string,
	testRunner?: TestRunner,
	pm?: PackageManager,
	baseBranch?: string,
	projectContext?: ProjectContext,
	manifestPath?: string,
	platform: PRPlatform = "cli",
	repoContextMd?: string | null,
	relevantFiles?: string | null,
): string {
	return buildPrompt({
		issue,
		variant: "native-worktree",
		testRunner,
		pm,
		baseBranch,
		projectContext,
		manifestPath,
		cwd: repoPath,
		platform,
		repoContextMd,
		relevantFiles,
	});
}

export function buildScopedImplementPrompt(
	issue: Issue,
	step: PlanStep,
	previousResults: PreviousStepResult[],
	testRunner?: TestRunner,
	pm?: PackageManager,
	isLastStep = false,
	baseBranch?: string,
	projectContext?: ProjectContext,
	manifestPath?: string,
	cwd?: string,
	platform: PRPlatform = "cli",
	repoContextMd?: string | null,
): string {
	return buildPrompt({
		issue,
		variant: "scoped",
		testRunner,
		pm,
		baseBranch,
		projectContext,
		manifestPath,
		cwd,
		platform,
		repoContextMd,
		step,
		previousResults,
		isLastStep,
	});
}
