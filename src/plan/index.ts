import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as clack from "@clack/prompts";
import { CliError } from "../cli/error.js";
import { resolveModels } from "../loop/models.js";
import * as logger from "../output/logger.js";
import { runWithFallback } from "../providers/index.js";
import { createSource } from "../sources/index.js";
import type { LisaConfig, PlannedIssue, PlanResult } from "../types/index.js";
import { createPlanIssues } from "./create.js";
import { PlanParseError, parsePlanResponse } from "./parser.js";
import { loadLatestPlan, savePlan } from "./persistence.js";
import { buildPlanningPrompt } from "./prompt.js";
import { runPlanWizard } from "./wizard.js";

export interface RunPlanOptions {
	config: LisaConfig;
	goal?: string;
	issueId?: string;
	continueLatest?: boolean;
	jsonOutput?: boolean;
}

const MAX_PARSE_RETRIES = 2;

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

	// Generate plan via AI
	const issues = await generatePlan(goal, config, parentDescription);

	// Create plan result
	const plan: PlanResult = {
		goal,
		sourceIssueId: opts.issueId,
		issues,
		createdAt: new Date().toISOString(),
		status: "draft",
	};

	const planPath = savePlan(workspace, plan);

	if (opts.jsonOutput) {
		console.log(JSON.stringify(plan, null, 2));
		return;
	}

	await reviewAndCreate(plan, planPath, opts);
}

async function generatePlan(
	goal: string,
	config: LisaConfig,
	parentDescription?: string,
): Promise<PlannedIssue[]> {
	const prompt = buildPlanningPrompt(goal, config, parentDescription);

	logger.log("Analyzing codebase and decomposing goal...");

	const models = resolveModels(config);
	const logDir = mkdtempSync(join(tmpdir(), "lisa-plan-"));
	const logFile = join(logDir, "plan.log");

	const result = await runWithFallback(models, prompt, {
		logFile,
		cwd: resolve(config.workspace),
		sessionTimeout: 120,
	});

	if (!result.success) {
		throw new CliError(`AI provider failed to generate plan: ${result.output.slice(0, 200)}`);
	}

	// Parse with retries
	let lastError: PlanParseError | null = null;
	for (let attempt = 0; attempt <= MAX_PARSE_RETRIES; attempt++) {
		try {
			if (attempt === 0) {
				return parsePlanResponse(result.output);
			}
			// Retry: re-invoke provider with error feedback
			const retryPrompt = `${prompt}\n\n## Previous Attempt Failed\n\nYour previous response could not be parsed: ${lastError!.message}\n\nPlease output ONLY valid JSON with the exact structure specified above.`;
			const retryResult = await runWithFallback(models, retryPrompt, {
				logFile,
				cwd: resolve(config.workspace),
				sessionTimeout: 120,
			});
			if (retryResult.success) {
				return parsePlanResponse(retryResult.output);
			}
		} catch (err) {
			if (err instanceof PlanParseError) {
				lastError = err;
				if (attempt < MAX_PARSE_RETRIES) {
					logger.warn(`Parse attempt ${attempt + 1} failed: ${err.message}. Retrying...`);
				}
			} else {
				throw err;
			}
		}
	}

	throw new CliError(
		`Failed to parse AI response after ${MAX_PARSE_RETRIES + 1} attempts: ${lastError?.message}`,
	);
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
