import { z } from "zod";

// ─── GitHub Issues ───────────────────────────────────────────────────────────

export const GitHubLabelSchema = z
	.object({
		name: z.string(),
	})
	.passthrough();

export const GitHubIssueSchema = z
	.object({
		number: z.number(),
		title: z.string(),
		body: z.string().nullable(),
		html_url: z.string(),
		labels: z.array(GitHubLabelSchema),
		created_at: z.string(),
		state: z.string().optional(),
		pull_request: z.object({}).passthrough().optional(),
	})
	.passthrough();

export const GitHubIssueListSchema = z.array(GitHubIssueSchema);

export const GitHubPrSchema = z
	.object({
		merged: z.boolean(),
		state: z.string(),
	})
	.passthrough();

export const GitHubCreateIssueResponseSchema = z
	.object({
		number: z.number(),
	})
	.passthrough();

export const GitHubCreateCommentResponseSchema = z
	.object({
		id: z.number(),
	})
	.passthrough();

export const GitHubLabelListSchema = z.array(
	z
		.object({
			name: z.string(),
			description: z.string().nullable(),
		})
		.passthrough(),
);

// ─── Jira ────────────────────────────────────────────────────────────────────

export const JiraIssueStatusSchema = z
	.object({
		name: z.string(),
	})
	.passthrough();

export const JiraIssueLinkSchema = z
	.object({
		type: z
			.object({
				name: z.string(),
				inward: z.string(),
				outward: z.string(),
			})
			.passthrough(),
		inwardIssue: z
			.object({
				key: z.string(),
				fields: z
					.object({
						status: z
							.object({
								name: z.string(),
								statusCategory: z.object({ key: z.string() }).passthrough(),
							})
							.passthrough(),
					})
					.passthrough(),
			})
			.passthrough()
			.optional(),
		outwardIssue: z
			.object({
				key: z.string(),
				fields: z
					.object({
						status: z
							.object({
								name: z.string(),
								statusCategory: z.object({ key: z.string() }).passthrough(),
							})
							.passthrough(),
					})
					.passthrough(),
			})
			.passthrough()
			.optional(),
	})
	.passthrough();

export const JiraIssueSchema = z
	.object({
		id: z.string(),
		key: z.string(),
		self: z.string(),
		fields: z
			.object({
				summary: z.string(),
				description: z.unknown(),
				priority: z.object({ name: z.string() }).passthrough().nullable(),
				status: JiraIssueStatusSchema,
				labels: z.array(z.string()),
				issuelinks: z.array(JiraIssueLinkSchema).optional(),
			})
			.passthrough(),
	})
	.passthrough();

export const JiraSearchResultSchema = z
	.object({
		issues: z.array(JiraIssueSchema),
		total: z.number(),
	})
	.passthrough();

export const JiraTransitionSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		to: z.object({ id: z.string(), name: z.string() }).passthrough(),
	})
	.passthrough();

export const JiraTransitionsResultSchema = z
	.object({
		transitions: z.array(JiraTransitionSchema),
	})
	.passthrough();

export const JiraIssueTypeStatusesSchema = z
	.object({
		statuses: z.array(z.object({ id: z.string(), name: z.string() }).passthrough()),
	})
	.passthrough();

export const JiraIssueTypeStatusesListSchema = z.array(JiraIssueTypeStatusesSchema);

export const JiraCreateIssueResponseSchema = z
	.object({
		key: z.string(),
	})
	.passthrough();

export const JiraProjectSearchSchema = z
	.object({
		values: z.array(z.object({ key: z.string(), name: z.string() }).passthrough()),
		total: z.number(),
	})
	.passthrough();

export const JiraLabelSearchSchema = z
	.object({
		values: z.array(z.string()),
		total: z.number(),
	})
	.passthrough();
