import { describe, expect, it } from "vitest";
import type { Issue, ValidationConfig } from "./types/index.js";
import { validateIssueSpec } from "./validation.js";

function makeIssue(partial: Partial<Issue> = {}): Issue {
	return {
		id: "INT-1",
		title: "Test issue",
		description: "",
		url: "https://example.com",
		...partial,
	};
}

describe("validateIssueSpec", () => {
	describe("empty description", () => {
		it("rejects issue with empty description", () => {
			const result = validateIssueSpec(makeIssue({ description: "" }));
			expect(result.valid).toBe(false);
			expect(result.reason).toContain("no description");
		});

		it("rejects issue with whitespace-only description", () => {
			const result = validateIssueSpec(makeIssue({ description: "   \n\t  " }));
			expect(result.valid).toBe(false);
			expect(result.reason).toContain("no description");
		});

		it("rejects issue with undefined description", () => {
			const result = validateIssueSpec(makeIssue({ description: undefined as unknown as string }));
			expect(result.valid).toBe(false);
			expect(result.reason).toContain("no description");
		});
	});

	describe("acceptance criteria detection", () => {
		it("accepts issue with markdown checklist", () => {
			const result = validateIssueSpec(
				makeIssue({
					description: "Implement feature.\n\n- [ ] User can log in\n- [ ] User can log out",
				}),
			);
			expect(result.valid).toBe(true);
		});

		it("accepts issue with 'acceptance criteria' keyword", () => {
			const result = validateIssueSpec(
				makeIssue({ description: "## Acceptance Criteria\nThe system should respond in < 200ms." }),
			);
			expect(result.valid).toBe(true);
		});

		it("accepts issue with 'expected' keyword", () => {
			const result = validateIssueSpec(
				makeIssue({ description: "Expected behavior: the button turns green after click." }),
			);
			expect(result.valid).toBe(true);
		});

		it("accepts issue with 'should' keyword", () => {
			const result = validateIssueSpec(
				makeIssue({ description: "The API should return a 200 status code." }),
			);
			expect(result.valid).toBe(true);
		});

		it("accepts issue with 'deve' keyword (Portuguese)", () => {
			const result = validateIssueSpec(
				makeIssue({ description: "O sistema deve validar o email do usuário." }),
			);
			expect(result.valid).toBe(true);
		});

		it("accepts issue with 'critérios' keyword (Portuguese)", () => {
			const result = validateIssueSpec(
				makeIssue({ description: "Critérios de aceite:\n- login funciona" }),
			);
			expect(result.valid).toBe(true);
		});

		it("rejects issue with description but no acceptance criteria", () => {
			const result = validateIssueSpec(
				makeIssue({ description: "This is a vague issue with no spec at all." }),
			);
			expect(result.valid).toBe(false);
			expect(result.reason).toContain("no detectable acceptance criteria");
		});

		it("rejects issue with only a title-like description", () => {
			const result = validateIssueSpec(makeIssue({ description: "Add dark mode" }));
			expect(result.valid).toBe(false);
		});
	});

	describe("config overrides", () => {
		it("passes all issues when require_acceptance_criteria is false", () => {
			const config: ValidationConfig = { require_acceptance_criteria: false };

			const noDesc = validateIssueSpec(makeIssue({ description: "" }), config);
			expect(noDesc.valid).toBe(true);

			const noSpec = validateIssueSpec(
				makeIssue({ description: "Vague issue with nothing." }),
				config,
			);
			expect(noSpec.valid).toBe(true);
		});

		it("validates normally when require_acceptance_criteria is true", () => {
			const config: ValidationConfig = { require_acceptance_criteria: true };
			const result = validateIssueSpec(makeIssue({ description: "" }), config);
			expect(result.valid).toBe(false);
		});

		it("validates normally when config is undefined", () => {
			const result = validateIssueSpec(makeIssue({ description: "" }), undefined);
			expect(result.valid).toBe(false);
		});
	});

	describe("valid result shape", () => {
		it("returns no reason when valid", () => {
			const result = validateIssueSpec(makeIssue({ description: "- [ ] Should implement login" }));
			expect(result.valid).toBe(true);
			expect(result.reason).toBeUndefined();
		});

		it("returns a reason when invalid", () => {
			const result = validateIssueSpec(makeIssue({ description: "" }));
			expect(result.valid).toBe(false);
			expect(typeof result.reason).toBe("string");
			expect(result.reason?.length).toBeGreaterThan(0);
		});
	});
});
