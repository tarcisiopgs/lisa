import { describe, expect, it } from "vitest";
import {
	buildCompliancePrompt,
	buildComplianceRecoveryPrompt,
	extractAcceptanceCriteria,
	formatSpecCompliance,
	isSpecComplianceEnabled,
	parseComplianceResponse,
} from "./spec-compliance.js";

describe("extractAcceptanceCriteria", () => {
	it("extracts markdown checklist items", () => {
		const desc = `## Description
Some context here.

## Acceptance Criteria
- [ ] User can log in with email
- [ ] Error message shown for invalid credentials
- [ ] Session persists across page refreshes`;

		const result = extractAcceptanceCriteria(desc);
		expect(result).toEqual([
			"User can log in with email",
			"Error message shown for invalid credentials",
			"Session persists across page refreshes",
		]);
	});

	it("extracts items under acceptance criteria header", () => {
		const desc = `## Acceptance Criteria
- Rate limiter returns 429
- Headers include X-RateLimit-Remaining
- Configurable per-route limits`;

		const result = extractAcceptanceCriteria(desc);
		expect(result).toEqual([
			"Rate limiter returns 429",
			"Headers include X-RateLimit-Remaining",
			"Configurable per-route limits",
		]);
	});

	it("extracts items under Portuguese header", () => {
		const desc = `## Critérios de Aceite
- Usuário pode fazer login com email
- Mensagem de erro para credenciais inválidas`;

		const result = extractAcceptanceCriteria(desc);
		expect(result).toEqual([
			"Usuário pode fazer login com email",
			"Mensagem de erro para credenciais inválidas",
		]);
	});

	it("extracts numbered items under header", () => {
		const desc = `## Acceptance Criteria
1. First criterion
2. Second criterion
3) Third criterion`;

		const result = extractAcceptanceCriteria(desc);
		expect(result).toEqual(["First criterion", "Second criterion", "Third criterion"]);
	});

	it("stops at next header", () => {
		const desc = `## Acceptance Criteria
- Criterion A
- Criterion B

## Technical Notes
- Not a criterion`;

		const result = extractAcceptanceCriteria(desc);
		expect(result).toEqual(["Criterion A", "Criterion B"]);
	});

	it("returns empty array when no criteria found", () => {
		const desc = "Just a plain description with no structure.";
		expect(extractAcceptanceCriteria(desc)).toEqual([]);
	});

	it("handles indented checklist items", () => {
		const desc = `Description:
	- [ ] Indented item
  - [ ] Space-indented item`;

		const result = extractAcceptanceCriteria(desc);
		expect(result).toEqual(["Indented item", "Space-indented item"]);
	});
});

describe("parseComplianceResponse", () => {
	it("parses valid JSON response", () => {
		const output = JSON.stringify({
			criteria: [
				{ criterion: "Login works", met: true, evidence: "Auth endpoint added" },
				{ criterion: "Error shown", met: false, evidence: "No error handling" },
			],
			summary: "1/2 criteria met",
			passed: false,
		});

		const result = parseComplianceResponse(output);
		expect(result).not.toBeNull();
		expect(result?.passed).toBe(false);
		expect(result?.criteria).toHaveLength(2);
		expect(result?.criteria[0]?.met).toBe(true);
		expect(result?.criteria[1]?.met).toBe(false);
	});

	it("parses JSON inside markdown code fence", () => {
		const output = `Here is the analysis:

\`\`\`json
{
  "criteria": [
    { "criterion": "A", "met": true, "evidence": "done" }
  ],
  "summary": "1/1 criteria met",
  "passed": true
}
\`\`\``;

		const result = parseComplianceResponse(output);
		expect(result).not.toBeNull();
		expect(result?.passed).toBe(true);
	});

	it("recomputes passed field based on criteria", () => {
		const output = JSON.stringify({
			criteria: [
				{ criterion: "A", met: true, evidence: "ok" },
				{ criterion: "B", met: true, evidence: "ok" },
			],
			summary: "2/2",
			passed: false, // Incorrect — should be true
		});

		const result = parseComplianceResponse(output);
		expect(result?.passed).toBe(true);
	});

	it("returns null for unparseable output", () => {
		expect(parseComplianceResponse("This is not JSON at all")).toBeNull();
	});

	it("returns null for JSON without criteria array", () => {
		expect(parseComplianceResponse('{"foo": "bar"}')).toBeNull();
	});
});

describe("buildCompliancePrompt", () => {
	it("includes issue info and criteria", () => {
		const issue = { id: "ABC-123", title: "Add login", description: "", url: "" };
		const criteria = ["User can log in", "Error shown"];
		const diff = "diff --git a/auth.ts";

		const prompt = buildCompliancePrompt(issue, criteria, diff);
		expect(prompt).toContain("ABC-123");
		expect(prompt).toContain("Add login");
		expect(prompt).toContain("1. User can log in");
		expect(prompt).toContain("2. Error shown");
		expect(prompt).toContain("diff --git a/auth.ts");
		expect(prompt).toContain("Do NOT create, edit, or modify any files");
	});
});

describe("buildComplianceRecoveryPrompt", () => {
	it("lists unmet criteria with evidence", () => {
		const issue = { id: "ABC-123", title: "Add login", description: "", url: "" };
		const unmet = [{ criterion: "Error shown", met: false, evidence: "No error handler in code" }];

		const prompt = buildComplianceRecoveryPrompt(issue, unmet);
		expect(prompt).toContain("ABC-123");
		expect(prompt).toContain("Error shown");
		expect(prompt).toContain("No error handler in code");
		expect(prompt).toContain("Do NOT create a new branch");
	});
});

describe("isSpecComplianceEnabled", () => {
	it("returns false when undefined", () => {
		expect(isSpecComplianceEnabled(undefined)).toBe(false);
	});

	it("returns false when disabled", () => {
		expect(isSpecComplianceEnabled({ enabled: false })).toBe(false);
	});

	it("returns true when enabled", () => {
		expect(isSpecComplianceEnabled({ enabled: true })).toBe(true);
	});
});

describe("formatSpecCompliance", () => {
	it("formats as markdown table", () => {
		const result = formatSpecCompliance({
			criteria: [
				{ criterion: "Login works", met: true, evidence: "Auth route exists" },
				{ criterion: "Error shown", met: false, evidence: "Missing handler" },
			],
			passed: false,
			summary: "1/2 criteria met",
		});

		expect(result).toContain("## Spec Compliance");
		expect(result).toContain("1/2 criteria met");
		expect(result).toContain("Login works");
		expect(result).toContain("Met");
		expect(result).toContain("Not Met");
	});

	it("escapes pipe characters in content", () => {
		const result = formatSpecCompliance({
			criteria: [{ criterion: "A | B", met: true, evidence: "C | D" }],
			passed: true,
			summary: "1/1",
		});

		expect(result).toContain("A \\| B");
		expect(result).toContain("C \\| D");
	});
});
