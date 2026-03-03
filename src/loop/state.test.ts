import { beforeEach, describe, expect, it } from "vitest";
import { hasUserQuitFromWatchPrompt, setUserQuitFromWatchPrompt } from "./state.js";

describe("watch prompt quit state", () => {
	beforeEach(() => {
		setUserQuitFromWatchPrompt(false);
	});

	it("hasUserQuitFromWatchPrompt returns false by default", () => {
		expect(hasUserQuitFromWatchPrompt()).toBe(false);
	});

	it("hasUserQuitFromWatchPrompt returns true after setUserQuitFromWatchPrompt(true)", () => {
		setUserQuitFromWatchPrompt(true);
		expect(hasUserQuitFromWatchPrompt()).toBe(true);
	});

	it("hasUserQuitFromWatchPrompt returns false after setUserQuitFromWatchPrompt(false)", () => {
		setUserQuitFromWatchPrompt(true);
		setUserQuitFromWatchPrompt(false);
		expect(hasUserQuitFromWatchPrompt()).toBe(false);
	});
});
