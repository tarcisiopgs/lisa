import type { Issue, ValidationConfig } from "./types/index.js";

/**
 * Patterns used to detect acceptance criteria in an issue description.
 * A match on any of these indicates the issue is sufficiently specified.
 */
const ACCEPTANCE_CRITERIA_PATTERNS: RegExp[] = [
	/- \[ \]/, // Markdown checklist item: - [ ]
	/critérios/i, // Portuguese: "critérios de aceite"
	/acceptance criteria/i, // English
	/expected behavior/i, // English alternative
	/\bexpected\b/i, // English: "expected output", etc.
	/\bdeve\b/i, // Portuguese: "deve fazer X"
	/\bshould\b/i, // English: "should do X"
];

export interface SpecValidationResult {
	valid: boolean;
	reason?: string;
}

/**
 * Validates that an issue has a minimum spec before Lisa accepts it for implementation.
 *
 * Checks:
 * 1. Description is non-empty
 * 2. Description contains detectable acceptance criteria (unless disabled via config)
 */
export function validateIssueSpec(issue: Issue, config?: ValidationConfig): SpecValidationResult {
	// If validation is explicitly disabled, always pass
	if (config?.require_acceptance_criteria === false) {
		return { valid: true };
	}

	// Check description is non-empty
	const description = issue.description?.trim() ?? "";
	if (!description) {
		return {
			valid: false,
			reason: "issue has no description",
		};
	}

	// Check for acceptance criteria indicators
	const hasAcceptanceCriteria = ACCEPTANCE_CRITERIA_PATTERNS.some((pattern) =>
		pattern.test(description),
	);
	if (!hasAcceptanceCriteria) {
		return {
			valid: false,
			reason:
				"issue description has no detectable acceptance criteria " +
				"(missing checklist `- [ ]`, 'acceptance criteria', 'expected', 'deve', 'should', or 'critérios')",
		};
	}

	return { valid: true };
}
