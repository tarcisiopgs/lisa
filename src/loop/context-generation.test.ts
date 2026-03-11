import { describe, expect, it } from "vitest";
import {
	buildContextGenerationPrompt,
	buildGlobalContextGenerationPrompt,
} from "./context-generation.js";

describe("buildContextGenerationPrompt", () => {
	it("includes the target file path", () => {
		const prompt = buildContextGenerationPrompt(
			"/repos/frontend",
			"/repos/frontend/.lisa/context.md",
		);
		expect(prompt).toContain("/repos/frontend/.lisa/context.md");
	});

	it("instructs agent to be concise", () => {
		const prompt = buildContextGenerationPrompt("/repo", "/repo/.lisa/context.md");
		expect(prompt).toContain("300");
	});

	it("instructs agent to write only non-obvious info", () => {
		const prompt = buildContextGenerationPrompt("/repo", "/repo/.lisa/context.md");
		expect(prompt).toContain("non-obvious");
	});
});

describe("buildGlobalContextGenerationPrompt", () => {
	it("includes all repo paths", () => {
		const repos = [
			{ name: "backend", path: "/ws/backend" },
			{ name: "frontend", path: "/ws/frontend" },
		];
		const prompt = buildGlobalContextGenerationPrompt(repos, "/ws/.lisa/context.md");
		expect(prompt).toContain("/ws/backend");
		expect(prompt).toContain("/ws/frontend");
	});

	it("instructs agent to document repo relationships", () => {
		const prompt = buildGlobalContextGenerationPrompt([], "/ws/.lisa/context.md");
		expect(prompt).toContain("relationship");
	});
});
