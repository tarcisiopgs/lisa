import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveModels } from "../loop/models.js";
import * as logger from "../output/logger.js";
import { buildContextMdBlock } from "../prompt.js";
import { runWithFallback } from "../providers/index.js";
import { readContext } from "../session/context-manager.js";
import type {
	LisaConfig,
	PlannedIssue,
	PlanValidationResult,
	ValidationFinding,
} from "../types/index.js";

/**
 * Build a prompt that asks the AI to evaluate a plan across 6 quality dimensions.
 */
export function buildPlanValidationPrompt(
	goal: string,
	issues: PlannedIssue[],
	contextMd: string | null,
): string {
	const contextBlock = buildContextMdBlock(contextMd);
	const issuesBlock = issues
		.map((issue) => {
			const deps = issue.dependsOn.length > 0 ? ` (depends on: ${issue.dependsOn.join(", ")})` : "";
			const verify = issue.verifyCommand ? `\n  Verify: ${issue.verifyCommand}` : "";
			const done = issue.doneCriteria ? `\n  Done: ${issue.doneCriteria}` : "";
			const files =
				issue.relevantFiles.length > 0 ? `\n  Files: ${issue.relevantFiles.join(", ")}` : "";
			const criteria =
				issue.acceptanceCriteria.length > 0
					? `\n  Criteria: ${issue.acceptanceCriteria.join("; ")}`
					: "";
			return `${issue.order}. ${issue.title}${deps}${files}${criteria}${verify}${done}`;
		})
		.join("\n\n");

	return `You are a plan quality validator. Your ONLY task is to evaluate whether an implementation plan is well-structured and complete. Do NOT modify any files or run any commands.

Always respond in the same language the user wrote their goal in.

## Goal

${goal}
${contextBlock}
## Plan to Validate

${issuesBlock}

## Evaluation Dimensions

Evaluate the plan across these 6 dimensions:

1. **Requirement Coverage**: Does the plan fully address the stated goal? Are there aspects of the goal that no issue covers?
2. **Task Atomicity**: Is each issue small enough to complete in a single AI coding session (under 1 hour)? Are any issues too broad or too granular?
3. **Dependency Correctness**: Are dependencies properly ordered? Are there missing dependencies where one issue clearly requires another to be completed first?
4. **File Scope**: Is the file scope per task reasonable? Do multiple issues modify the same files (merge conflict risk)?
5. **Verification**: Does each issue have testable acceptance criteria or a verify command? Can completion be objectively determined?
6. **Gap Detection**: Are there missing implementation steps? Would executing all issues actually achieve the goal?

## Response Format

Respond with ONLY a valid JSON object — no markdown fences, no explanation, no other text:

{
  "passed": true,
  "findings": [
    { "dimension": "requirement_coverage", "severity": "low", "description": "Minor: no logging added", "suggestion": "Consider adding a logging issue" }
  ],
  "refinedPlan": null
}

When "passed" is false, include a "refinedPlan" with the corrected issues:

{
  "passed": false,
  "findings": [
    { "dimension": "gap_detection", "severity": "high", "description": "Missing database migration step", "suggestion": "Add an issue for the migration", "issueOrder": 2 }
  ],
  "refinedPlan": {
    "issues": [
      { "title": "...", "description": "...", "acceptanceCriteria": ["..."], "relevantFiles": ["..."], "order": 1, "dependsOn": [], "verifyCommand": "...", "doneCriteria": "..." }
    ]
  }
}

IMPORTANT:
- Set "passed" to false ONLY for high-severity findings that would cause implementation failure.
- Medium and low findings are informational — the plan can still pass.
- Do NOT create, edit, or modify any files.
- Do NOT run any shell commands.
- ONLY output the JSON object above.`;
}

/**
 * Parse the plan validation JSON response from the AI.
 * Resilient to markdown fences and extra text around the JSON.
 */
export function parsePlanValidationResponse(output: string): PlanValidationResult | null {
	const jsonPatterns = [
		/\{[\s\S]*"findings"[\s\S]*\}/,
		/```(?:json)?\s*(\{[\s\S]*"findings"[\s\S]*\})\s*```/,
	];

	for (const pattern of jsonPatterns) {
		const match = pattern.exec(output);
		if (match) {
			const jsonStr = match[1] ?? match[0];
			try {
				const parsed = JSON.parse(jsonStr) as PlanValidationResult & Record<string, unknown>;
				if (Array.isArray(parsed.findings)) {
					const hasHighSeverity = parsed.findings.some((f) => f.severity === "high");
					return {
						passed: hasHighSeverity ? false : parsed.passed !== false,
						findings: parsed.findings,
						refinedIssues: parseRefinedIssues(parsed),
					};
				}
			} catch {
				// Try next pattern
			}
		}
	}

	return null;
}

function parseRefinedIssues(parsed: Record<string, unknown>): PlannedIssue[] | undefined {
	const refined = parsed.refinedPlan as { issues?: unknown[] } | null | undefined;
	if (!refined?.issues || !Array.isArray(refined.issues)) return undefined;

	return refined.issues
		.filter(
			(i): i is Record<string, unknown> =>
				typeof i === "object" &&
				i !== null &&
				typeof (i as Record<string, unknown>).title === "string",
		)
		.map((issue, idx) => ({
			title: String(issue.title),
			description: typeof issue.description === "string" ? issue.description : "",
			acceptanceCriteria: Array.isArray(issue.acceptanceCriteria)
				? (issue.acceptanceCriteria as unknown[]).filter((c): c is string => typeof c === "string")
				: [],
			relevantFiles: Array.isArray(issue.relevantFiles)
				? (issue.relevantFiles as unknown[]).filter((f): f is string => typeof f === "string")
				: [],
			order: typeof issue.order === "number" ? issue.order : idx + 1,
			dependsOn: Array.isArray(issue.dependsOn)
				? (issue.dependsOn as unknown[]).filter((d): d is number => typeof d === "number")
				: [],
			repo: typeof issue.repo === "string" ? issue.repo : undefined,
			verifyCommand: typeof issue.verifyCommand === "string" ? issue.verifyCommand : undefined,
			doneCriteria: typeof issue.doneCriteria === "string" ? issue.doneCriteria : undefined,
		}));
}

/**
 * Validate a plan via AI and iteratively refine it.
 * Returns the final issues and accumulated findings.
 */
export async function validateAndRefinePlan(
	goal: string,
	issues: PlannedIssue[],
	config: LisaConfig,
): Promise<{ issues: PlannedIssue[]; findings: ValidationFinding[] }> {
	const maxIterations = config.plan_validation?.max_iterations ?? 2;
	const workspace = resolve(config.workspace);
	const contextMd = readContext(workspace);
	const models = resolveModels(config);
	const logDir = mkdtempSync(join(tmpdir(), "lisa-plan-check-"));
	const logFile = join(logDir, "plan-check.log");

	let currentIssues = issues;
	const allFindings: ValidationFinding[] = [];

	for (let iteration = 0; iteration < maxIterations; iteration++) {
		const prompt = buildPlanValidationPrompt(goal, currentIssues, contextMd);

		const result = await runWithFallback(models, prompt, {
			logFile,
			cwd: workspace,
			sessionTimeout: 120,
		});

		if (!result.success) {
			logger.warn("Plan validation failed — skipping quality gate.");
			break;
		}

		const validation = parsePlanValidationResponse(result.output);
		if (!validation) {
			logger.warn("Could not parse validation response — skipping quality gate.");
			break;
		}

		allFindings.push(...validation.findings);

		if (validation.passed) {
			logger.ok(
				`Plan validated (iteration ${iteration + 1}): ${validation.findings.length} finding(s).`,
			);
			break;
		}

		// Plan did not pass — use refined issues if available
		if (validation.refinedIssues && validation.refinedIssues.length > 0) {
			logger.log(
				`Plan refined (iteration ${iteration + 1}/${maxIterations}): ${validation.findings.filter((f) => f.severity === "high").length} high-severity finding(s).`,
			);
			currentIssues = validation.refinedIssues;
		} else {
			// No refined plan provided — can't iterate further
			logger.warn("Validation failed but no refined plan provided — using current plan.");
			break;
		}
	}

	return { issues: currentIssues, findings: allFindings };
}
