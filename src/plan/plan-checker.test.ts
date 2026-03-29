import { describe, expect, it } from "vitest";
import type { PlannedIssue } from "../types/index.js";
import { buildPlanValidationPrompt, parsePlanValidationResponse } from "./plan-checker.js";

const makeIssue = (overrides: Partial<PlannedIssue> = {}): PlannedIssue => ({
	title: "Add auth middleware",
	description: "Add JWT authentication middleware",
	acceptanceCriteria: ["Middleware validates JWT tokens", "Returns 401 on invalid token"],
	relevantFiles: ["src/middleware/auth.ts"],
	order: 1,
	dependsOn: [],
	...overrides,
});

describe("buildPlanValidationPrompt", () => {
	it("includes goal and issue titles", () => {
		const issues = [makeIssue(), makeIssue({ title: "Add rate limiter", order: 2 })];
		const prompt = buildPlanValidationPrompt("Add auth and rate limiting", issues, null);

		expect(prompt).toContain("Add auth and rate limiting");
		expect(prompt).toContain("Add auth middleware");
		expect(prompt).toContain("Add rate limiter");
	});

	it("includes all 6 evaluation dimensions", () => {
		const prompt = buildPlanValidationPrompt("Goal", [makeIssue()], null);

		expect(prompt).toContain("Requirement Coverage");
		expect(prompt).toContain("Task Atomicity");
		expect(prompt).toContain("Dependency Correctness");
		expect(prompt).toContain("File Scope");
		expect(prompt).toContain("Verification");
		expect(prompt).toContain("Gap Detection");
	});

	it("includes codebase context when provided", () => {
		const prompt = buildPlanValidationPrompt(
			"Goal",
			[makeIssue()],
			"# Project Context\nThis is a Node.js project",
		);

		expect(prompt).toContain("Project Context");
	});

	it("includes verify command and done criteria when present", () => {
		const issues = [makeIssue({ verifyCommand: "npm test", doneCriteria: "All tests pass" })];
		const prompt = buildPlanValidationPrompt("Goal", issues, null);

		expect(prompt).toContain("Verify: npm test");
		expect(prompt).toContain("Done: All tests pass");
	});

	it("includes dependency info", () => {
		const issues = [
			makeIssue({ order: 1 }),
			makeIssue({ title: "Add routes", order: 2, dependsOn: [1] }),
		];
		const prompt = buildPlanValidationPrompt("Goal", issues, null);

		expect(prompt).toContain("depends on: 1");
	});

	it("includes language instruction", () => {
		const prompt = buildPlanValidationPrompt("Goal", [makeIssue()], null);

		expect(prompt).toContain("Always respond in the same language");
	});
});

describe("parsePlanValidationResponse", () => {
	it("parses a valid passed response", () => {
		const response = JSON.stringify({
			passed: true,
			findings: [
				{
					dimension: "verification",
					severity: "low",
					description: "Issue 2 has no verify command",
					suggestion: "Add a verify command",
				},
			],
			refinedPlan: null,
		});

		const result = parsePlanValidationResponse(response);
		expect(result).not.toBeNull();
		expect(result!.passed).toBe(true);
		expect(result!.findings).toHaveLength(1);
		expect(result!.findings[0]!.dimension).toBe("verification");
		expect(result!.refinedIssues).toBeUndefined();
	});

	it("parses a valid failed response with refined plan", () => {
		const response = JSON.stringify({
			passed: false,
			findings: [
				{
					dimension: "gap_detection",
					severity: "high",
					description: "Missing migration",
					suggestion: "Add migration issue",
				},
			],
			refinedPlan: {
				issues: [
					{
						title: "Run migration",
						description: "Create DB migration",
						acceptanceCriteria: ["Migration runs"],
						relevantFiles: ["db/migrate.ts"],
						order: 1,
						dependsOn: [],
						verifyCommand: "npm run migrate",
						doneCriteria: "Migration completes",
					},
				],
			},
		});

		const result = parsePlanValidationResponse(response);
		expect(result).not.toBeNull();
		expect(result!.passed).toBe(false);
		expect(result!.findings).toHaveLength(1);
		expect(result!.refinedIssues).toHaveLength(1);
		expect(result!.refinedIssues![0]!.title).toBe("Run migration");
		expect(result!.refinedIssues![0]!.verifyCommand).toBe("npm run migrate");
	});

	it("handles markdown-fenced JSON", () => {
		const response = `Here is my evaluation:

\`\`\`json
{
  "passed": true,
  "findings": [],
  "refinedPlan": null
}
\`\`\``;

		const result = parsePlanValidationResponse(response);
		expect(result).not.toBeNull();
		expect(result!.passed).toBe(true);
		expect(result!.findings).toHaveLength(0);
	});

	it("returns null for invalid JSON", () => {
		const result = parsePlanValidationResponse("This is not JSON at all");
		expect(result).toBeNull();
	});

	it("returns null for JSON without findings array", () => {
		const result = parsePlanValidationResponse('{"passed": true}');
		expect(result).toBeNull();
	});

	it("forces passed=false when high-severity findings exist", () => {
		const response = JSON.stringify({
			passed: true,
			findings: [
				{
					dimension: "gap_detection",
					severity: "high",
					description: "Critical gap",
					suggestion: "Fix it",
				},
			],
		});

		const result = parsePlanValidationResponse(response);
		expect(result).not.toBeNull();
		expect(result!.passed).toBe(false);
	});

	it("handles refined plan with missing optional fields", () => {
		const response = JSON.stringify({
			passed: false,
			findings: [
				{ dimension: "atomicity", severity: "high", description: "Too large", suggestion: "Split" },
			],
			refinedPlan: {
				issues: [
					{ title: "Part A", order: 1 },
					{ title: "Part B", order: 2, dependsOn: [1] },
				],
			},
		});

		const result = parsePlanValidationResponse(response);
		expect(result!.refinedIssues).toHaveLength(2);
		expect(result!.refinedIssues![0]!.acceptanceCriteria).toEqual([]);
		expect(result!.refinedIssues![0]!.relevantFiles).toEqual([]);
		expect(result!.refinedIssues![1]!.dependsOn).toEqual([1]);
	});
});
