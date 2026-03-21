import { resolve } from "node:path";
import * as clack from "@clack/prompts";
import { CliError } from "../cli/error.js";
import * as logger from "../output/logger.js";
import { createSource } from "../sources/index.js";
import type { LisaConfig, PlanResult } from "../types/index.js";
import { runBrainstormingPhase } from "./brainstorm.js";
import { createPlanIssues } from "./create.js";
import { generatePlan } from "./generate.js";
import { loadLatestPlan, savePlan } from "./persistence.js";
import { runPlanWizard } from "./wizard.js";

export interface RunPlanOptions {
	config: LisaConfig;
	goal?: string;
	issueId?: string;
	continueLatest?: boolean;
	jsonOutput?: boolean;
	yes?: boolean;
	noBrainstorm?: boolean;
}

export async function runPlan(opts: RunPlanOptions): Promise<void> {
	const { config } = opts;
	const workspace = resolve(config.workspace);

	// Resume interrupted plan
	if (opts.continueLatest) {
		const latest = loadLatestPlan(workspace);
		if (!latest)
			throw new CliError("No interrupted plan found. Run `lisa plan` to start a new one.");
		const [plan, planPath] = latest;
		logger.log(`Resuming plan from ${planPath}`);
		await reviewAndCreate(plan, planPath, opts);
		return;
	}

	// Resolve goal
	let goal = opts.goal ?? "";
	let parentDescription: string | undefined;

	if (opts.issueId) {
		const source = createSource(config.source);
		const issue = await source.fetchIssueById(opts.issueId);
		if (!issue) throw new CliError(`Issue ${opts.issueId} not found`);
		goal = goal || issue.title;
		parentDescription = issue.description;
	}

	if (!goal) {
		throw new CliError(
			'Provide a goal: lisa plan "Add rate limiting" or lisa plan --issue EPIC-123',
		);
	}

	// Brainstorming phase (unless skipped)
	let refinedGoal = goal;
	let brainstormHistory: { role: "user" | "ai"; content: string }[] | undefined;

	if (!opts.noBrainstorm && !opts.jsonOutput && !opts.yes) {
		const brainstorm = await runBrainstormingPhase(goal, config);
		refinedGoal = brainstorm.refinedGoal;
		brainstormHistory = brainstorm.history.length > 0 ? brainstorm.history : undefined;

		// Confirmation gate: verify understanding before generating
		if (!opts.yes && brainstorm.summary !== goal) {
			const confirmed = await clack.confirm({
				message: "Proceed with this understanding?",
			});
			if (clack.isCancel(confirmed) || !confirmed) {
				logger.log("Plan cancelled.");
				return;
			}
		}
	}

	// Generate plan via AI
	const issues = await generatePlan(refinedGoal, config, { parentDescription });

	// Create plan result
	const plan: PlanResult = {
		goal: refinedGoal,
		sourceIssueId: opts.issueId,
		issues,
		createdAt: new Date().toISOString(),
		status: "draft",
		brainstormHistory,
	};

	const planPath = savePlan(workspace, plan);

	if (opts.jsonOutput) {
		console.log(JSON.stringify(plan, null, 2));
		return;
	}

	await reviewAndCreate(plan, planPath, opts);
}

async function reviewAndCreate(
	plan: PlanResult,
	planPath: string,
	opts: RunPlanOptions,
): Promise<void> {
	const { config } = opts;

	// Interactive wizard review
	const approved = await runPlanWizard(plan, planPath, opts);
	if (!approved) {
		logger.log("Plan cancelled. Saved for later: lisa plan --continue");
		return;
	}

	// Create issues in source
	const source = createSource(config.source);
	if (!source.createIssue) {
		throw new CliError(
			`Source "${config.source}" does not support issue creation. Create issues manually.`,
		);
	}

	// Confirmation gate before creating issues
	if (!opts.yes) {
		const confirm = await clack.confirm({
			message: `Create ${plan.issues.length} issue${plan.issues.length !== 1 ? "s" : ""} in ${config.source}?`,
		});
		if (clack.isCancel(confirm) || !confirm) {
			plan.status = "draft";
			savePlan(resolve(config.workspace), plan);
			logger.log("Plan saved. Resume with: lisa plan --continue");
			return;
		}
	}

	logger.log("Creating issues in source...");
	const createdIds = await createPlanIssues(source, config.source_config, plan);

	plan.status = "created";
	plan.createdIssueIds = createdIds;
	savePlan(resolve(config.workspace), plan);

	logger.ok(`${createdIds.length} issue${createdIds.length !== 1 ? "s" : ""} created.`);
	for (let i = 0; i < createdIds.length; i++) {
		logger.log(`  ${plan.issues[i]!.order}. ${createdIds[i]}: ${plan.issues[i]!.title}`);
	}

	// Handoff prompt
	const runNow = await clack.confirm({
		message: `Execute now with lisa run?`,
		initialValue: false,
	});

	if (clack.isCancel(runNow) || !runNow) {
		logger.log("Run `lisa run` when ready.");
		return;
	}

	// Dynamic import to avoid circular dependency
	const { runLoop } = await import("../loop/index.js");
	await runLoop(config, {
		once: false,
		watch: false,
		limit: createdIds.length,
		dryRun: false,
		concurrency: 1,
	});
}
