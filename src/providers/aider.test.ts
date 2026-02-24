import { describe, expect, it } from "vitest";
import type { Provider } from "../types.js";
import { AiderProvider } from "./aider.js";

describe("AiderProvider", () => {
	it("has name aider", () => {
		const provider = new AiderProvider();
		expect(provider.name).toBe("aider");
	});

	it("does not support native worktree", () => {
		const provider: Provider = new AiderProvider();
		expect(provider.supportsNativeWorktree).toBeFalsy();
	});
});
