import { describe, expect, it } from "vitest";
import type { PrFeedback } from "./pr-feedback.js";
import { formatPrFeedbackEntry, parsePrUrl } from "./pr-feedback.js";

describe("parsePrUrl", () => {
	it("parses a valid HTTPS PR URL", () => {
		const result = parsePrUrl("https://github.com/owner/repo/pull/42");
		expect(result).toEqual({ owner: "owner", repo: "repo", prNumber: "42" });
	});

	it("parses a PR URL without https scheme", () => {
		const result = parsePrUrl("github.com/org/my-repo/pull/123");
		expect(result).toEqual({ owner: "org", repo: "my-repo", prNumber: "123" });
	});

	it("returns null for an invalid URL", () => {
		expect(parsePrUrl("https://gitlab.com/owner/repo/merge_requests/1")).toBeNull();
		expect(parsePrUrl("not-a-url")).toBeNull();
		expect(parsePrUrl("https://github.com/owner/repo/issues/1")).toBeNull();
	});
});

describe("formatPrFeedbackEntry", () => {
	const baseFeedback: PrFeedback = {
		prUrl: "https://github.com/owner/repo/pull/42",
		title: "feat: add dark mode",
		state: "closed",
		reviews: [],
		comments: [],
	};

	it("includes the issue ID and date in the header", () => {
		const entry = formatPrFeedbackEntry(baseFeedback, "INT-100", "2026-02-27");
		expect(entry).toContain("## PR Feedback for Issue INT-100 (2026-02-27)");
	});

	it("includes the PR URL and title", () => {
		const entry = formatPrFeedbackEntry(baseFeedback, "INT-100", "2026-02-27");
		expect(entry).toContain("- PR: https://github.com/owner/repo/pull/42");
		expect(entry).toContain("- Title: feat: add dark mode");
	});

	it("marks the status as closed without merge", () => {
		const entry = formatPrFeedbackEntry(baseFeedback, "INT-100", "2026-02-27");
		expect(entry).toContain("- Status: Closed without merge");
	});

	it("formats reviews in a code block", () => {
		const feedback: PrFeedback = {
			...baseFeedback,
			reviews: [
				{
					author: "reviewer1",
					state: "CHANGES_REQUESTED",
					body: "Please fix the logic here",
					submittedAt: "2026-02-27T10:00:00Z",
				},
			],
		};
		const entry = formatPrFeedbackEntry(feedback, "INT-100", "2026-02-27");
		expect(entry).toContain("- Reviews:");
		expect(entry).toContain("```");
		expect(entry).toContain("[reviewer1] CHANGES_REQUESTED: Please fix the logic here");
	});

	it("formats inline comments with file path and line number", () => {
		const feedback: PrFeedback = {
			...baseFeedback,
			comments: [
				{
					author: "reviewer2",
					body: "This variable name is confusing",
					path: "src/index.ts",
					line: 42,
					createdAt: "2026-02-27T10:00:00Z",
				},
			],
		};
		const entry = formatPrFeedbackEntry(feedback, "INT-100", "2026-02-27");
		expect(entry).toContain("- Inline comments:");
		expect(entry).toContain("[reviewer2] (src/index.ts:42): This variable name is confusing");
	});

	it("formats inline comments with path but no line number", () => {
		const feedback: PrFeedback = {
			...baseFeedback,
			comments: [
				{
					author: "reviewer2",
					body: "General file comment",
					path: "src/index.ts",
					createdAt: "2026-02-27T10:00:00Z",
				},
			],
		};
		const entry = formatPrFeedbackEntry(feedback, "INT-100", "2026-02-27");
		expect(entry).toContain("[reviewer2] (src/index.ts): General file comment");
	});

	it("formats inline comments with no path", () => {
		const feedback: PrFeedback = {
			...baseFeedback,
			comments: [
				{
					author: "reviewer3",
					body: "General PR comment",
					createdAt: "2026-02-27T10:00:00Z",
				},
			],
		};
		const entry = formatPrFeedbackEntry(feedback, "INT-100", "2026-02-27");
		expect(entry).toContain("[reviewer3]: General PR comment");
	});

	it("omits reviews section when there are no reviews", () => {
		const entry = formatPrFeedbackEntry(baseFeedback, "INT-100", "2026-02-27");
		expect(entry).not.toContain("- Reviews:");
	});

	it("omits inline comments section when there are no comments", () => {
		const entry = formatPrFeedbackEntry(baseFeedback, "INT-100", "2026-02-27");
		expect(entry).not.toContain("- Inline comments:");
	});

	it("includes both reviews and comments when both are present", () => {
		const feedback: PrFeedback = {
			...baseFeedback,
			reviews: [
				{
					author: "reviewer1",
					state: "CHANGES_REQUESTED",
					body: "Needs changes",
					submittedAt: "2026-02-27T10:00:00Z",
				},
			],
			comments: [
				{
					author: "reviewer2",
					body: "Inline note",
					path: "src/app.ts",
					line: 10,
					createdAt: "2026-02-27T10:00:00Z",
				},
			],
		};
		const entry = formatPrFeedbackEntry(feedback, "INT-100", "2026-02-27");
		expect(entry).toContain("- Reviews:");
		expect(entry).toContain("- Inline comments:");
	});

	it("starts with the ## header (no leading newline)", () => {
		const entry = formatPrFeedbackEntry(baseFeedback, "INT-100", "2026-02-27");
		expect(entry.startsWith("## PR Feedback")).toBe(true);
	});
});
