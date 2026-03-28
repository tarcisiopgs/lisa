import { describe, expect, it } from "vitest";
import type { ReviewComment } from "../types/index.js";
import {
	buildReviewFingerprint,
	buildReviewRecoveryPrompt,
	parseReviewDecision,
} from "./review-monitor.js";

describe("parseReviewDecision", () => {
	it("maps APPROVED to approved", () => {
		expect(parseReviewDecision("APPROVED")).toBe("approved");
	});

	it("maps CHANGES_REQUESTED to changes_requested", () => {
		expect(parseReviewDecision("CHANGES_REQUESTED")).toBe("changes_requested");
	});

	it("maps REVIEW_REQUIRED to review_pending", () => {
		expect(parseReviewDecision("REVIEW_REQUIRED")).toBe("review_pending");
	});

	it("maps empty string to review_pending", () => {
		expect(parseReviewDecision("")).toBe("review_pending");
	});

	it("maps undefined to review_pending", () => {
		expect(parseReviewDecision(undefined)).toBe("review_pending");
	});
});

describe("buildReviewFingerprint", () => {
	const comments: ReviewComment[] = [
		{ id: "1", author: "alice", body: "Fix this", url: "https://example.com/1" },
		{ id: "2", author: "bob", body: "Refactor that", url: "https://example.com/2" },
		{ id: "3", author: "carol", body: "Add tests", url: "https://example.com/3" },
	];

	it("returns stable hash from comment IDs regardless of order", () => {
		const reversed = [...comments].reverse();
		const hash1 = buildReviewFingerprint(comments);
		const hash2 = buildReviewFingerprint(reversed);
		expect(hash1).toBe(hash2);
	});

	it("returns a 16-char hex string", () => {
		const hash = buildReviewFingerprint(comments);
		expect(hash).toHaveLength(16);
		expect(hash).toMatch(/^[0-9a-f]{16}$/);
	});

	it("returns empty string for empty array", () => {
		expect(buildReviewFingerprint([])).toBe("");
	});
});

describe("buildReviewRecoveryPrompt", () => {
	const issue = { id: "ISS-42", title: "Add dark mode support" };
	const comments: ReviewComment[] = [
		{
			id: "101",
			author: "reviewer1",
			body: "Please extract this into a separate function.",
			path: "src/theme.ts",
			line: 24,
			url: "https://github.com/example/repo/pull/5#discussion_r101",
		},
		{
			id: "102",
			author: "reviewer2",
			body: "This PR is missing tests.",
			url: "https://github.com/example/repo/pull/5#discussion_r102",
		},
	];

	const prompt = buildReviewRecoveryPrompt(issue, comments, "feature/dark-mode");

	it("contains issue ID", () => {
		expect(prompt).toContain("ISS-42");
	});

	it("contains author names", () => {
		expect(prompt).toContain("reviewer1");
		expect(prompt).toContain("reviewer2");
	});

	it("contains comment bodies", () => {
		expect(prompt).toContain("Please extract this into a separate function.");
		expect(prompt).toContain("This PR is missing tests.");
	});

	it("contains file path for file-level comment", () => {
		expect(prompt).toContain("src/theme.ts");
	});

	it("shows general comment for comments without a path", () => {
		expect(prompt).toContain("**General comment**");
	});

	it("contains branch name in instructions", () => {
		expect(prompt).toContain("feature/dark-mode");
	});
});
