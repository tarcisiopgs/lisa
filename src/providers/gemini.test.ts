import { describe, expect, it } from "vitest";
import { GeminiProvider } from "./gemini.js";

describe("GeminiProvider", () => {
	it("has name gemini", () => {
		const provider = new GeminiProvider();
		expect(provider.name).toBe("gemini");
	});
});
