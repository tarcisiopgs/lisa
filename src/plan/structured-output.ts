import type { PlannedIssue } from "../types/index.js";
import { PlanParseError, parsePlanResponse } from "./parser.js";

export type StructuredPlanOutput =
	| { type: "question"; text: string }
	| { type: "summary"; text: string }
	| { type: "issues"; issues: PlannedIssue[] };

interface RawStructuredOutput {
	type: string;
	text?: string;
	issues?: unknown[];
}

/**
 * Parse provider output into a structured plan response.
 *
 * Tries to extract a JSON object with a `type` field from the raw output.
 * Falls back to treating the entire output as a plain-text question if
 * no valid structured JSON is found.
 */
export function parseStructuredOutput(raw: string): StructuredPlanOutput {
	const cleaned = stripAnsi(raw).trim();

	// Try to find a structured JSON object with a "type" field
	const parsed = extractStructuredJson(cleaned);
	if (parsed) {
		if (parsed.type === "issues" && Array.isArray(parsed.issues)) {
			// Delegate to the existing issue parser for validation
			try {
				const issues = parsePlanResponse(JSON.stringify({ issues: parsed.issues }));
				return { type: "issues", issues };
			} catch {
				// Fall through to try parsing the whole output as issues
			}
		}

		if (parsed.type === "summary" && typeof parsed.text === "string") {
			return { type: "summary", text: parsed.text };
		}

		if (parsed.type === "question" && typeof parsed.text === "string") {
			return { type: "question", text: parsed.text };
		}
	}

	// Fallback: try parsing the whole output as an issues JSON (legacy format)
	try {
		const issues = parsePlanResponse(cleaned);
		return { type: "issues", issues };
	} catch {
		// Not issues JSON either
	}

	// Final fallback: treat as plain-text question
	return { type: "question", text: extractCleanText(cleaned) };
}

/**
 * Try to extract a JSON object with a "type" field from the output.
 * Searches from the end of the string to skip tool call noise.
 */
function extractStructuredJson(text: string): RawStructuredOutput | null {
	// First try: look for JSON in markdown fences
	const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
	if (fenceMatch) {
		const result = tryParseStructured(fenceMatch[1]!.trim());
		if (result) return result;
	}

	// Second try: find JSON objects from the end (last one is most likely the response)
	const bracePositions: number[] = [];
	for (let i = text.length - 1; i >= 0; i--) {
		if (text[i] === "}") {
			bracePositions.push(i);
		}
	}

	for (const endPos of bracePositions) {
		// Find matching open brace by scanning backwards
		let depth = 0;
		let startPos = -1;
		for (let i = endPos; i >= 0; i--) {
			if (text[i] === "}") depth++;
			if (text[i] === "{") depth--;
			if (depth === 0) {
				startPos = i;
				break;
			}
		}

		if (startPos !== -1) {
			const candidate = text.slice(startPos, endPos + 1);
			const result = tryParseStructured(candidate);
			if (result) return result;
		}
	}

	return null;
}

function tryParseStructured(jsonStr: string): RawStructuredOutput | null {
	try {
		const obj = JSON.parse(jsonStr) as Record<string, unknown>;
		if (typeof obj === "object" && obj !== null && typeof obj.type === "string") {
			return obj as unknown as RawStructuredOutput;
		}
	} catch {
		// not valid JSON
	}
	return null;
}

/** Strip ANSI escape codes from a string. */
function stripAnsi(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI stripping
	return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

/**
 * Extract meaningful text from provider output for the fallback case.
 * Takes the last substantial paragraph, skipping tool call noise.
 */
function extractCleanText(text: string): string {
	if (text.length < 500) return text;

	const lines = text.split("\n").filter((l) => l.trim().length > 0);
	return lines.slice(-10).join("\n");
}
