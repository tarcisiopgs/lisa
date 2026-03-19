import { describe, expect, it } from "vitest";
import { PlanParseError, parsePlanResponse } from "./parser.js";

describe("parsePlanResponse", () => {
	const validJson = JSON.stringify({
		issues: [
			{
				title: "Add rate limiter",
				description: "Create rate limiting middleware",
				acceptanceCriteria: ["Returns 429 on limit", "Uses Redis"],
				relevantFiles: ["src/middleware/rate-limit.ts"],
				order: 1,
				dependsOn: [],
			},
			{
				title: "Wire to routes",
				description: "Apply middleware to API routes",
				acceptanceCriteria: ["All /api routes limited"],
				relevantFiles: ["src/routes/users.ts"],
				order: 2,
				dependsOn: [1],
				repo: "api",
			},
		],
	});

	it("parses valid JSON response", () => {
		const issues = parsePlanResponse(validJson);
		expect(issues).toHaveLength(2);
		expect(issues[0]!.title).toBe("Add rate limiter");
		expect(issues[0]!.order).toBe(1);
		expect(issues[0]!.dependsOn).toEqual([]);
		expect(issues[1]!.dependsOn).toEqual([1]);
		expect(issues[1]!.repo).toBe("api");
	});

	it("strips markdown code fences", () => {
		const wrapped = `\`\`\`json\n${validJson}\n\`\`\``;
		const issues = parsePlanResponse(wrapped);
		expect(issues).toHaveLength(2);
	});

	it("extracts JSON from surrounding text", () => {
		const messy = `Here is the plan:\n\n${validJson}\n\nLet me know!`;
		const issues = parsePlanResponse(messy);
		expect(issues).toHaveLength(2);
	});

	it("throws PlanParseError on missing JSON", () => {
		expect(() => parsePlanResponse("No JSON here")).toThrow(PlanParseError);
	});

	it("throws PlanParseError on invalid JSON", () => {
		expect(() => parsePlanResponse('{"issues": [{')).toThrow(PlanParseError);
	});

	it("throws PlanParseError on empty issues array", () => {
		expect(() => parsePlanResponse('{"issues":[]}')).toThrow(PlanParseError);
	});

	it("throws PlanParseError on too many issues", () => {
		const tooMany = {
			issues: Array.from({ length: 13 }, (_, i) => ({
				title: `Issue ${i}`,
				description: "desc",
				acceptanceCriteria: [],
				relevantFiles: [],
				order: i + 1,
				dependsOn: [],
			})),
		};
		expect(() => parsePlanResponse(JSON.stringify(tooMany))).toThrow(PlanParseError);
	});

	it("throws PlanParseError on missing title", () => {
		const noTitle = { issues: [{ description: "desc", order: 1 }] };
		expect(() => parsePlanResponse(JSON.stringify(noTitle))).toThrow(PlanParseError);
	});

	it("defaults order to index+1 when missing", () => {
		const noOrder = {
			issues: [
				{ title: "A", description: "d", acceptanceCriteria: [], relevantFiles: [] },
				{ title: "B", description: "d", acceptanceCriteria: [], relevantFiles: [] },
			],
		};
		const issues = parsePlanResponse(JSON.stringify(noOrder));
		expect(issues[0]!.order).toBe(1);
		expect(issues[1]!.order).toBe(2);
	});

	it("filters non-string values from arrays", () => {
		const mixed = {
			issues: [
				{
					title: "Test",
					description: "desc",
					acceptanceCriteria: ["valid", 123, null],
					relevantFiles: ["file.ts", 456],
					order: 1,
					dependsOn: [1, "bad"],
				},
			],
		};
		const issues = parsePlanResponse(JSON.stringify(mixed));
		expect(issues[0]!.acceptanceCriteria).toEqual(["valid"]);
		expect(issues[0]!.relevantFiles).toEqual(["file.ts"]);
		expect(issues[0]!.dependsOn).toEqual([1]);
	});
});
