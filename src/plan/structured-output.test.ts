import { describe, expect, it } from "vitest";
import { parseStructuredOutput } from "./structured-output.js";

describe("parseStructuredOutput", () => {
	describe("question type", () => {
		it("parses clean JSON question", () => {
			const input = '{"type": "question", "text": "Which endpoints should be rate-limited?"}';
			const result = parseStructuredOutput(input);
			expect(result).toEqual({
				type: "question",
				text: "Which endpoints should be rate-limited?",
			});
		});

		it("parses question wrapped in markdown fences", () => {
			const input = '```json\n{"type": "question", "text": "What scope?"}\n```';
			const result = parseStructuredOutput(input);
			expect(result).toEqual({ type: "question", text: "What scope?" });
		});

		it("parses question with surrounding noise", () => {
			const input =
				'[tool_call] some noise\n{"type": "question", "text": "Which endpoints?"}\nmore noise';
			const result = parseStructuredOutput(input);
			expect(result).toEqual({ type: "question", text: "Which endpoints?" });
		});
	});

	describe("summary type", () => {
		it("parses clean JSON summary", () => {
			const input =
				'{"type": "summary", "text": "I understand you want rate limiting on /api/users."}';
			const result = parseStructuredOutput(input);
			expect(result).toEqual({
				type: "summary",
				text: "I understand you want rate limiting on /api/users.",
			});
		});

		it("parses summary with ready field (ignored but accepted)", () => {
			const input = '{"type": "summary", "text": "Summary here.", "ready": true}';
			const result = parseStructuredOutput(input);
			expect(result).toEqual({ type: "summary", text: "Summary here." });
		});
	});

	describe("issues type", () => {
		const validIssues = [
			{
				title: "Add rate limiter",
				description: "Create middleware",
				acceptanceCriteria: ["Returns 429"],
				relevantFiles: ["src/middleware.ts"],
				order: 1,
				dependsOn: [],
			},
		];

		it("parses structured issues output", () => {
			const input = JSON.stringify({ type: "issues", issues: validIssues });
			const result = parseStructuredOutput(input);
			expect(result.type).toBe("issues");
			if (result.type === "issues") {
				expect(result.issues).toHaveLength(1);
				expect(result.issues[0]!.title).toBe("Add rate limiter");
			}
		});

		it("parses legacy issues format (no type field)", () => {
			const input = JSON.stringify({ issues: validIssues });
			const result = parseStructuredOutput(input);
			expect(result.type).toBe("issues");
			if (result.type === "issues") {
				expect(result.issues).toHaveLength(1);
			}
		});
	});

	describe("fallback to plain text", () => {
		it("returns plain text as question when no JSON found", () => {
			const input = "Which endpoints should be rate-limited?";
			const result = parseStructuredOutput(input);
			expect(result).toEqual({
				type: "question",
				text: "Which endpoints should be rate-limited?",
			});
		});

		it("returns plain text when JSON is invalid", () => {
			const input = '{"type": "question", "text": broken}';
			const result = parseStructuredOutput(input);
			expect(result.type).toBe("question");
			expect(result).toHaveProperty("text");
		});

		it("strips ANSI codes from fallback text", () => {
			const input = "\x1b[32mWhat scope?\x1b[0m";
			const result = parseStructuredOutput(input);
			expect(result).toEqual({ type: "question", text: "What scope?" });
		});

		it("trims long output to last 10 lines in fallback", () => {
			// Each line must be long enough to exceed 500 chars total
			const lines = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}: ${"x".repeat(40)}`);
			const input = lines.join("\n");
			const result = parseStructuredOutput(input);
			expect(result.type).toBe("question");
			if (result.type === "question") {
				const resultLines = result.text.split("\n");
				expect(resultLines).toHaveLength(10);
				expect(resultLines[0]).toContain("Line 11");
			}
		});
	});

	describe("edge cases", () => {
		it("handles empty string", () => {
			const result = parseStructuredOutput("");
			expect(result).toEqual({ type: "question", text: "" });
		});

		it("prefers structured JSON over legacy issues format", () => {
			const input = JSON.stringify({
				type: "question",
				text: "Need more info",
			});
			const result = parseStructuredOutput(input);
			expect(result.type).toBe("question");
		});

		it("finds JSON at end of long provider output", () => {
			const noise = Array.from({ length: 50 }, (_, i) => `[tool_call_${i}] processing...`).join(
				"\n",
			);
			const json = '{"type": "question", "text": "What framework?"}';
			const input = `${noise}\n${json}`;
			const result = parseStructuredOutput(input);
			expect(result).toEqual({ type: "question", text: "What framework?" });
		});

		it("handles JSON with extra fields gracefully", () => {
			const input = '{"type": "summary", "text": "Got it.", "confidence": 0.9, "ready": true}';
			const result = parseStructuredOutput(input);
			expect(result).toEqual({ type: "summary", text: "Got it." });
		});

		it("ignores JSON objects without type field in structured search", () => {
			const input = '{"name": "test", "value": 42}\nWhat should I do?';
			const result = parseStructuredOutput(input);
			expect(result.type).toBe("question");
		});
	});
});
