import * as logger from "../logger.js";
import type { Issue, Source, SourceConfig } from "../types.js";

const API_URL = "https://api.linear.app/graphql";
const REQUEST_TIMEOUT_MS = 30_000;

function getApiKey(): string {
	const key = process.env.LINEAR_API_KEY;
	if (!key) throw new Error("LINEAR_API_KEY is not set");
	return key;
}

async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
	const res = await fetch(API_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: getApiKey(),
		},
		body: JSON.stringify({ query, variables }),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Linear API error (${res.status}): ${text}`);
	}

	const json = (await res.json()) as { data: T; errors?: { message: string }[] };
	if (json.errors?.length) {
		throw new Error(`Linear GraphQL error: ${json.errors.map((e) => e.message).join(", ")}`);
	}
	return json.data;
}

export class LinearSource implements Source {
	name = "linear" as const;

	async fetchNextIssue(config: SourceConfig): Promise<Issue | null> {
		const data = await gql<{
			issues: {
				nodes: {
					id: string;
					identifier: string;
					title: string;
					description: string;
					url: string;
					priority: number;
					inverseRelations: {
						nodes: {
							type: string;
							issue: {
								identifier: string;
								state: { type: string };
							};
						}[];
					};
				}[];
			};
		}>(
			`query($teamName: String!, $projectName: String!, $labelName: String!, $statusName: String!) {
				issues(
					filter: {
						team: { name: { eq: $teamName } }
						project: { name: { eq: $projectName } }
						labels: { name: { eq: $labelName } }
						state: { name: { eq: $statusName } }
					}
					first: 50
				) {
					nodes {
						id
						identifier
						title
						description
						url
						priority
						inverseRelations(first: 50) {
							nodes {
								type
								issue {
									identifier
									state { type }
								}
							}
						}
					}
				}
			}`,
			{
				teamName: config.team,
				projectName: config.project,
				labelName: config.label,
				statusName: config.pick_from,
			},
		);

		const issues = data.issues.nodes;
		if (issues.length === 0) return null;

		// Separate unblocked from blocked issues based on dependency relations
		const unblocked: typeof issues = [];
		const blocked: { identifier: string; blockers: string[] }[] = [];

		for (const issue of issues) {
			const activeBlockers = issue.inverseRelations.nodes
				.filter((r) => r.type === "blocks")
				.filter((r) => r.issue.state.type !== "completed" && r.issue.state.type !== "canceled")
				.map((r) => r.issue.identifier);

			if (activeBlockers.length === 0) {
				unblocked.push(issue);
			} else {
				blocked.push({ identifier: issue.identifier, blockers: activeBlockers });
			}
		}

		if (unblocked.length === 0) {
			if (blocked.length > 0) {
				logger.warn("No unblocked issues found. Blocked issues:");
				for (const entry of blocked) {
					logger.warn(`  ${entry.identifier} — blocked by: ${entry.blockers.join(", ")}`);
				}
			}
			return null;
		}

		// Sort by priority: 1=urgent, 2=high, 3=medium, 4=low, 0=no priority
		unblocked.sort((a, b) => {
			const pa = a.priority === 0 ? 5 : a.priority;
			const pb = b.priority === 0 ? 5 : b.priority;
			return pa - pb;
		});

		const issue = unblocked[0];
		if (!issue) return null;
		return {
			id: issue.identifier,
			title: issue.title,
			description: issue.description || "",
			url: issue.url,
		};
	}

	async fetchIssueById(id: string): Promise<Issue | null> {
		const identifier = parseLinearIdentifier(id);

		const data = await gql<{
			issue: {
				id: string;
				identifier: string;
				title: string;
				description: string;
				url: string;
			} | null;
		}>(
			`query($identifier: String!) {
				issue(id: $identifier) {
					id
					identifier
					title
					description
					url
				}
			}`,
			{ identifier },
		);

		if (!data.issue) return null;

		return {
			id: data.issue.identifier,
			title: data.issue.title,
			description: data.issue.description || "",
			url: data.issue.url,
		};
	}

	async updateStatus(issueId: string, statusName: string): Promise<void> {
		// Resolve issue internal ID and team
		const issueData = await gql<{
			issue: { id: string; team: { id: string } };
		}>(
			`query($identifier: String!) {
				issue(id: $identifier) {
					id
					team { id }
				}
			}`,
			{ identifier: issueId },
		);

		// Resolve status name to state ID
		const statesData = await gql<{
			workflowStates: { nodes: { id: string; name: string }[] };
		}>(
			`query($teamId: ID!) {
				workflowStates(filter: { team: { id: { eq: $teamId } } }) {
					nodes { id name }
				}
			}`,
			{ teamId: issueData.issue.team.id },
		);

		const state = statesData.workflowStates.nodes.find(
			(s) => s.name.toLowerCase() === statusName.toLowerCase(),
		);
		if (!state) {
			const available = statesData.workflowStates.nodes.map((s) => s.name).join(", ");
			throw new Error(`Status "${statusName}" not found. Available: ${available}`);
		}

		await gql(
			`mutation($issueId: String!, $stateId: String!) {
				issueUpdate(id: $issueId, input: { stateId: $stateId }) {
					success
				}
			}`,
			{ issueId: issueData.issue.id, stateId: state.id },
		);
	}

	async attachPullRequest(_issueId: string, _prUrl: string): Promise<void> {
		// Linear auto-links PRs via branch name — no manual attachment needed
	}

	async removeLabel(issueId: string, labelName: string): Promise<void> {
		// Get issue with current labels
		const issueData = await gql<{
			issue: { id: string; labels: { nodes: { id: string; name: string }[] } };
		}>(
			`query($identifier: String!) {
				issue(id: $identifier) {
					id
					labels { nodes { id name } }
				}
			}`,
			{ identifier: issueId },
		);

		const currentLabels = issueData.issue.labels.nodes;
		const filtered = currentLabels.filter((l) => l.name.toLowerCase() !== labelName.toLowerCase());

		// If nothing changed, skip
		if (filtered.length === currentLabels.length) return;

		await gql(
			`mutation($issueId: String!, $labelIds: [String!]!) {
				issueUpdate(id: $issueId, input: { labelIds: $labelIds }) {
					success
				}
			}`,
			{
				issueId: issueData.issue.id,
				labelIds: filtered.map((l) => l.id),
			},
		);
	}
}

function parseLinearIdentifier(input: string): string {
	// Extract identifier from Linear URL: https://linear.app/team/issue/INT-150/slug
	const urlMatch = input.match(/\/issue\/([A-Z]+-\d+)/);
	if (urlMatch?.[1]) return urlMatch[1];

	// Already an identifier like INT-150
	return input;
}
