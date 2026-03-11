import { describe, expect, it } from "vitest";
import { extractPrUrlFromOutput } from "./manifest.js";

describe("extractPrUrlFromOutput", () => {
	it("extracts a GitHub PR URL", () => {
		const output = "Created pull request https://github.com/org/repo/pull/30 successfully";
		expect(extractPrUrlFromOutput(output)).toBe("https://github.com/org/repo/pull/30");
	});

	it("extracts a GitLab merge request URL", () => {
		const output =
			"MR created at https://gitlab.company.com/group/project/-/merge_requests/42 done";
		expect(extractPrUrlFromOutput(output)).toBe(
			"https://gitlab.company.com/group/project/-/merge_requests/42",
		);
	});

	it("extracts a Bitbucket pull request URL", () => {
		const output = "PR: https://bitbucket.org/team/repo/pull-requests/15";
		expect(extractPrUrlFromOutput(output)).toBe("https://bitbucket.org/team/repo/pull-requests/15");
	});

	it("returns null when no PR URL is found", () => {
		const output = "No PR was created. Something went wrong.";
		expect(extractPrUrlFromOutput(output)).toBeNull();
	});

	it("returns the first match when multiple PR URLs are present", () => {
		const output = [
			"First: https://github.com/org/repo/pull/10",
			"Second: https://github.com/org/repo/pull/20",
		].join("\n");
		expect(extractPrUrlFromOutput(output)).toBe("https://github.com/org/repo/pull/10");
	});

	it("extracts URL from multiline output with noise", () => {
		const output = [
			"Running tests...",
			"All tests passed.",
			"Pushing to origin...",
			"remote: Create a pull request for 'feat/fix' on GitHub by visiting:",
			"remote:   https://github.com/org/repo/pull/30",
			"Branch pushed.",
		].join("\n");
		expect(extractPrUrlFromOutput(output)).toBe("https://github.com/org/repo/pull/30");
	});

	it("handles http URLs (not just https)", () => {
		const output = "PR at http://github.com/org/repo/pull/5";
		expect(extractPrUrlFromOutput(output)).toBe("http://github.com/org/repo/pull/5");
	});
});
