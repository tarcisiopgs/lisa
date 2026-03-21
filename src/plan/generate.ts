import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CliError } from "../cli/error.js";
import { resolveModels } from "../loop/models.js";
import * as logger from "../output/logger.js";
import { runWithFallback } from "../providers/index.js";
import type { LisaConfig, PlannedIssue } from "../types/index.js";
import { PlanParseError, parsePlanResponse } from "./parser.js";
import { buildPlanningPrompt } from "./prompt.js";

const MAX_PARSE_RETRIES = 2;

/**
 * Generate a plan by invoking the AI provider.
 * Optionally accepts `feedback` to enrich the prompt when regenerating.
 */
export async function generatePlan(
	goal: string,
	config: LisaConfig,
	opts?: {
		parentDescription?: string;
		feedback?: string;
		previousTitles?: string[];
	},
): Promise<PlannedIssue[]> {
	let prompt = buildPlanningPrompt(goal, config, opts?.parentDescription);

	if (opts?.feedback) {
		const previousBlock =
			opts.previousTitles && opts.previousTitles.length > 0
				? `\nThe previous plan had ${opts.previousTitles.length} issues: ${opts.previousTitles.join(", ")}`
				: "";
		prompt += `\n\n## Regeneration Feedback\n\nThe user reviewed the previous plan and wants changes:${previousBlock}\n\nUser feedback: ${opts.feedback}\n\nRegenerate the plan considering this feedback. Output ONLY the JSON structure defined above.`;
	}

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
