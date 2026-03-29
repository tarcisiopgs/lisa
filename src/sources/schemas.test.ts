import { describe, expect, it } from "vitest";
import {
	GitHubCreateCommentResponseSchema,
	GitHubCreateIssueResponseSchema,
	GitHubIssueListSchema,
	GitHubIssueSchema,
	GitHubPrSchema,
	JiraIssueSchema,
	JiraSearchResultSchema,
} from "./schemas.js";

describe("GitHub schemas", () => {
	describe("GitHubIssueSchema", () => {
		it("validates a valid issue response", () => {
			const data = {
				number: 42,
				title: "Fix bug",
				body: "Some description",
				html_url: "https://github.com/owner/repo/issues/42",
				labels: [{ name: "bug" }],
				created_at: "2024-01-01T00:00:00Z",
				state: "open",
			};
			const result = GitHubIssueSchema.safeParse(data);
			expect(result.success).toBe(true);
		});

		it("allows null body", () => {
			const data = {
				number: 1,
				title: "No body",
				body: null,
				html_url: "https://github.com/owner/repo/issues/1",
				labels: [],
				created_at: "2024-01-01T00:00:00Z",
			};
			const result = GitHubIssueSchema.safeParse(data);
			expect(result.success).toBe(true);
		});

		it("allows extra fields (passthrough)", () => {
			const data = {
				number: 1,
				title: "Extra fields",
				body: null,
				html_url: "https://github.com/owner/repo/issues/1",
				labels: [],
				created_at: "2024-01-01T00:00:00Z",
				assignees: [{ login: "user" }],
				milestone: { title: "v1" },
			};
			const result = GitHubIssueSchema.safeParse(data);
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.assignees).toEqual([{ login: "user" }]);
			}
		});

		it("rejects missing required field (number)", () => {
			const data = {
				title: "No number",
				body: null,
				html_url: "https://github.com/owner/repo/issues/1",
				labels: [],
				created_at: "2024-01-01T00:00:00Z",
			};
			const result = GitHubIssueSchema.safeParse(data);
			expect(result.success).toBe(false);
		});

		it("rejects missing required field (title)", () => {
			const data = {
				number: 1,
				body: null,
				html_url: "https://github.com/owner/repo/issues/1",
				labels: [],
				created_at: "2024-01-01T00:00:00Z",
			};
			const result = GitHubIssueSchema.safeParse(data);
			expect(result.success).toBe(false);
		});

		it("rejects wrong type for labels", () => {
			const data = {
				number: 1,
				title: "Bad labels",
				body: null,
				html_url: "https://github.com/owner/repo/issues/1",
				labels: "not-an-array",
				created_at: "2024-01-01T00:00:00Z",
			};
			const result = GitHubIssueSchema.safeParse(data);
			expect(result.success).toBe(false);
		});

		it("allows optional pull_request field", () => {
			const data = {
				number: 1,
				title: "PR",
				body: null,
				html_url: "https://github.com/owner/repo/pull/1",
				labels: [],
				created_at: "2024-01-01T00:00:00Z",
				pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/1" },
			};
			const result = GitHubIssueSchema.safeParse(data);
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.pull_request).toBeDefined();
			}
		});
	});

	describe("GitHubIssueListSchema", () => {
		it("validates an array of issues", () => {
			const data = [
				{
					number: 1,
					title: "First",
					body: "desc",
					html_url: "https://github.com/o/r/issues/1",
					labels: [],
					created_at: "2024-01-01T00:00:00Z",
				},
				{
					number: 2,
					title: "Second",
					body: null,
					html_url: "https://github.com/o/r/issues/2",
					labels: [{ name: "bug" }],
					created_at: "2024-01-02T00:00:00Z",
				},
			];
			const result = GitHubIssueListSchema.safeParse(data);
			expect(result.success).toBe(true);
		});

		it("validates empty array", () => {
			const result = GitHubIssueListSchema.safeParse([]);
			expect(result.success).toBe(true);
		});

		it("rejects non-array", () => {
			const result = GitHubIssueListSchema.safeParse({ issues: [] });
			expect(result.success).toBe(false);
		});
	});

	describe("GitHubPrSchema", () => {
		it("validates a valid PR response", () => {
			const data = { merged: true, state: "closed" };
			const result = GitHubPrSchema.safeParse(data);
			expect(result.success).toBe(true);
		});

		it("rejects missing merged field", () => {
			const data = { state: "open" };
			const result = GitHubPrSchema.safeParse(data);
			expect(result.success).toBe(false);
		});
	});

	describe("GitHubCreateIssueResponseSchema", () => {
		it("validates a valid create response", () => {
			const data = { number: 123, id: 456, node_id: "abc" };
			const result = GitHubCreateIssueResponseSchema.safeParse(data);
			expect(result.success).toBe(true);
		});

		it("rejects missing number", () => {
			const data = { id: 456 };
			const result = GitHubCreateIssueResponseSchema.safeParse(data);
			expect(result.success).toBe(false);
		});
	});

	describe("GitHubCreateCommentResponseSchema", () => {
		it("validates a valid comment response", () => {
			const data = { id: 789, body: "comment text" };
			const result = GitHubCreateCommentResponseSchema.safeParse(data);
			expect(result.success).toBe(true);
		});

		it("rejects missing id", () => {
			const data = { body: "no id" };
			const result = GitHubCreateCommentResponseSchema.safeParse(data);
			expect(result.success).toBe(false);
		});
	});
});

describe("Jira schemas", () => {
	describe("JiraIssueSchema", () => {
		it("validates a valid Jira issue", () => {
			const data = {
				id: "10001",
				key: "ENG-123",
				self: "https://example.atlassian.net/rest/api/3/issue/10001",
				fields: {
					summary: "Fix login bug",
					description: null,
					priority: { name: "High" },
					status: { name: "To Do" },
					labels: ["backend", "urgent"],
				},
			};
			const result = JiraIssueSchema.safeParse(data);
			expect(result.success).toBe(true);
		});

		it("allows null priority", () => {
			const data = {
				id: "10002",
				key: "ENG-456",
				self: "https://example.atlassian.net/rest/api/3/issue/10002",
				fields: {
					summary: "No priority",
					description: null,
					priority: null,
					status: { name: "Open" },
					labels: [],
				},
			};
			const result = JiraIssueSchema.safeParse(data);
			expect(result.success).toBe(true);
		});

		it("allows extra fields (passthrough)", () => {
			const data = {
				id: "10003",
				key: "ENG-789",
				self: "https://example.atlassian.net/rest/api/3/issue/10003",
				fields: {
					summary: "Extra fields",
					description: null,
					priority: null,
					status: { name: "Done" },
					labels: [],
					customfield_10001: "custom value",
				},
				expand: "operations",
			};
			const result = JiraIssueSchema.safeParse(data);
			expect(result.success).toBe(true);
		});

		it("rejects missing key", () => {
			const data = {
				id: "10001",
				self: "https://example.atlassian.net/rest/api/3/issue/10001",
				fields: {
					summary: "No key",
					description: null,
					priority: null,
					status: { name: "Open" },
					labels: [],
				},
			};
			const result = JiraIssueSchema.safeParse(data);
			expect(result.success).toBe(false);
		});

		it("rejects missing summary in fields", () => {
			const data = {
				id: "10001",
				key: "ENG-123",
				self: "https://example.atlassian.net/rest/api/3/issue/10001",
				fields: {
					description: null,
					priority: null,
					status: { name: "Open" },
					labels: [],
				},
			};
			const result = JiraIssueSchema.safeParse(data);
			expect(result.success).toBe(false);
		});

		it("validates issue with issuelinks", () => {
			const data = {
				id: "10001",
				key: "ENG-123",
				self: "https://example.atlassian.net/rest/api/3/issue/10001",
				fields: {
					summary: "With links",
					description: null,
					priority: null,
					status: { name: "Open" },
					labels: [],
					issuelinks: [
						{
							type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
							inwardIssue: {
								key: "ENG-100",
								fields: {
									status: {
										name: "Done",
										statusCategory: { key: "done" },
									},
								},
							},
						},
					],
				},
			};
			const result = JiraIssueSchema.safeParse(data);
			expect(result.success).toBe(true);
		});
	});

	describe("JiraSearchResultSchema", () => {
		it("validates a valid search result", () => {
			const data = {
				issues: [
					{
						id: "10001",
						key: "ENG-123",
						self: "https://example.atlassian.net/rest/api/3/issue/10001",
						fields: {
							summary: "Test issue",
							description: null,
							priority: null,
							status: { name: "Open" },
							labels: [],
						},
					},
				],
				total: 1,
			};
			const result = JiraSearchResultSchema.safeParse(data);
			expect(result.success).toBe(true);
		});

		it("validates empty search result", () => {
			const data = { issues: [], total: 0 };
			const result = JiraSearchResultSchema.safeParse(data);
			expect(result.success).toBe(true);
		});

		it("rejects missing issues array", () => {
			const data = { total: 0 };
			const result = JiraSearchResultSchema.safeParse(data);
			expect(result.success).toBe(false);
		});

		it("rejects missing total", () => {
			const data = { issues: [] };
			const result = JiraSearchResultSchema.safeParse(data);
			expect(result.success).toBe(false);
		});
	});
});
