import type { PlannedIssue } from "../types/index.js";

interface RawPlanResponse {
	issues: {
		title: string;
		description: string;
		acceptanceCriteria: string[];
		relevantFiles: string[];
		order: number;
		dependsOn: number[];
		repo?: string;
		verifyCommand?: string;
		doneCriteria?: string;
	}[];
}

/**
 * Parse the AI response into PlannedIssue[].
 * Handles JSON wrapped in markdown code fences.
 * Throws on invalid structure.
 */
export function parsePlanResponse(raw: string): PlannedIssue[] {
	// Strip markdown code fences if present
	let cleaned = raw.trim();
	const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
	if (fenceMatch) {
		cleaned = fenceMatch[1]!.trim();
	}

	// Try to find JSON object in the output
	const jsonStart = cleaned.indexOf("{");
	const jsonEnd = cleaned.lastIndexOf("}");
	if (jsonStart === -1 || jsonEnd === -1) {
		throw new PlanParseError("No JSON object found in AI response");
	}
	cleaned = cleaned.slice(jsonStart, jsonEnd + 1);

	let parsed: RawPlanResponse;
	try {
		parsed = JSON.parse(cleaned) as RawPlanResponse;
	} catch (err) {
		throw new PlanParseError(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
	}

	if (!Array.isArray(parsed.issues) || parsed.issues.length === 0) {
		throw new PlanParseError("Response must contain a non-empty 'issues' array");
	}

	if (parsed.issues.length > 12) {
		throw new PlanParseError(
			`Too many issues (${parsed.issues.length}). Decompose into 2-8 atomic issues.`,
		);
	}

	const issues: PlannedIssue[] = parsed.issues.map((issue, idx) => {
		if (!issue.title || typeof issue.title !== "string") {
			throw new PlanParseError(`Issue ${idx + 1}: missing or invalid 'title'`);
		}
		if (!issue.description || typeof issue.description !== "string") {
			throw new PlanParseError(`Issue ${idx + 1}: missing or invalid 'description'`);
		}

		return {
			title: issue.title,
			description: issue.description,
			acceptanceCriteria: Array.isArray(issue.acceptanceCriteria)
				? issue.acceptanceCriteria.filter((c) => typeof c === "string")
				: [],
			relevantFiles: Array.isArray(issue.relevantFiles)
				? issue.relevantFiles.filter((f) => typeof f === "string")
				: [],
			order: typeof issue.order === "number" ? issue.order : idx + 1,
			dependsOn: Array.isArray(issue.dependsOn)
				? issue.dependsOn.filter((d) => typeof d === "number")
				: [],
			repo: typeof issue.repo === "string" ? issue.repo : undefined,
			verifyCommand: typeof issue.verifyCommand === "string" ? issue.verifyCommand : undefined,
			doneCriteria: typeof issue.doneCriteria === "string" ? issue.doneCriteria : undefined,
		};
	});

	return issues;
}

export class PlanParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PlanParseError";
	}
}
