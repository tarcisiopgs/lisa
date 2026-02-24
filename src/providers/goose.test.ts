import { describe, expect, it } from "vitest";
import type { Provider } from "../types.js";
import { GooseProvider } from "./goose.js";

describe("GooseProvider", () => {
	it("has name goose", () => {
		const provider = new GooseProvider();
		expect(provider.name).toBe("goose");
	});

	it("does not support native worktree", () => {
		const provider: Provider = new GooseProvider();
		expect(provider.supportsNativeWorktree).toBeFalsy();
	});
});
