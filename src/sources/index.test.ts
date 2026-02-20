import { describe, expect, it } from "vitest";
import { createSource } from "./index.js";

describe("createSource", () => {
	it("creates a linear source", () => {
		const source = createSource("linear");
		expect(source.name).toBe("linear");
	});

	it("creates a trello source", () => {
		const source = createSource("trello");
		expect(source.name).toBe("trello");
	});

	it("throws for unknown source", () => {
		expect(() => createSource("unknown" as never)).toThrow("Unknown source: unknown");
	});
});
