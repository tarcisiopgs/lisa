import * as logger from "../output/logger.js";
import type { CreateIssueOpts, Issue, Source, SourceConfig } from "../types/index.js";
import { normalizeLabels, REQUEST_TIMEOUT_MS } from "./base.js";

const API_URL = "https://api.linear.app/graphql";

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
		const labels = normalizeLabels(config);
		const primaryLabel = labels[0] ?? "";
		const data = await gql<{
			issues: {
				nodes: {
					id: string;
					identifier: string;
					title: string;
					description: string;
					url: string;
					priority: number;
					labels: { nodes: { name: string }[] };
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
						labels { nodes { name } }
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
				teamName: config.scope,
				projectName: config.project,
				labelName: primaryLabel,
				statusName: config.pick_from,
			},
		);

		// Client-side filter: ensure issue has ALL configured labels (AND logic)
		const issues =
			labels.length > 1
				? data.issues.nodes.filter((issue) => {
						const issueLabels = new Set(issue.labels.nodes.map((l) => l.name.toLowerCase()));
						return labels.every((l) => issueLabels.has(l.toLowerCase()));
					})
				: data.issues.nodes;
		if (issues.length === 0) return null;

		// Separate unblocked from blocked issues based on dependency relations
		const unblocked: (typeof issues)[number][] = [];
		const blocked: { identifier: string; blockers: string[] }[] = [];
		// Track completed blocker IDs per issue for dependency resolution
		const completedBlockerMap = new Map<string, string[]>();

		for (const issue of issues) {
			const blockerRelations = issue.inverseRelations.nodes.filter((r) => r.type === "blocks");

			const activeBlockers = blockerRelations
				.filter((r) => r.issue.state.type !== "completed" && r.issue.state.type !== "canceled")
				.map((r) => r.issue.identifier);

			const completedBlockers = blockerRelations
				.filter((r) => r.issue.state.type === "completed")
				.map((r) => r.issue.identifier);

			if (completedBlockers.length > 0) {
				completedBlockerMap.set(issue.identifier, completedBlockers);
			}

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

		const completedBlockerIds = completedBlockerMap.get(issue.identifier);
		return {
			id: issue.identifier,
			title: issue.title,
			description: issue.description || "",
			url: issue.url,
			...(completedBlockerIds && { completedBlockerIds }),
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
				state: { name: string } | null;
			} | null;
		}>(
			`query($identifier: String!) {
				issue(id: $identifier) {
					id
					identifier
					title
					description
					url
					state { name }
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
			status: data.issue.state?.name,
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

		const mutationResult = await gql<{
			issueUpdate: { success: boolean };
		}>(
			`mutation($issueId: String!, $stateId: String!) {
				issueUpdate(id: $issueId, input: { stateId: $stateId }) {
					success
				}
			}`,
			{ issueId: issueData.issue.id, stateId: state.id },
		);

		if (!mutationResult.issueUpdate.success) {
			throw new Error(
				`issueUpdate returned success=false for ${issueId} (stateId: ${state.id}, stateName: ${state.name})`,
			);
		}
	}

	async attachPullRequest(_issueId: string, _prUrl: string): Promise<void> {
		// Linear auto-links PRs via branch name — no manual attachment needed
	}

	async completeIssue(issueId: string, statusName: string, labelToRemove?: string): Promise<void> {
		// Resolve issue internal ID, team, and current labels in a single query
		const issueData = await gql<{
			issue: {
				id: string;
				team: { id: string };
				labels: { nodes: { id: string; name: string }[] };
			};
		}>(
			`query($identifier: String!) {
				issue(id: $identifier) {
					id
					team { id }
					labels { nodes { id name } }
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

		// Build a single issueUpdate input with both stateId and labelIds
		const input: Record<string, unknown> = { stateId: state.id };

		if (labelToRemove) {
			const currentLabels = issueData.issue.labels.nodes;
			const filtered = currentLabels.filter(
				(l) => l.name.toLowerCase() !== labelToRemove.toLowerCase(),
			);
			if (filtered.length !== currentLabels.length) {
				input.labelIds = filtered.map((l) => l.id);
			}
		}

		const mutationResult = await gql<{
			issueUpdate: { success: boolean };
		}>(
			`mutation($issueId: String!, $input: IssueUpdateInput!) {
				issueUpdate(id: $issueId, input: $input) {
					success
				}
			}`,
			{ issueId: issueData.issue.id, input },
		);

		if (!mutationResult.issueUpdate.success) {
			throw new Error(
				`issueUpdate returned success=false for ${issueId} (stateId: ${state.id}, stateName: ${state.name})`,
			);
		}
	}

	async listIssues(config: SourceConfig): Promise<Issue[]> {
		const labels = normalizeLabels(config);
		const primaryLabel = labels[0] ?? "";
		const data = await gql<{
			issues: {
				nodes: {
					identifier: string;
					title: string;
					description: string;
					url: string;
					labels: { nodes: { name: string }[] };
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
					first: 100
				) {
					nodes {
						identifier
						title
						description
						url
						labels { nodes { name } }
					}
				}
			}`,
			{
				teamName: config.scope,
				projectName: config.project,
				labelName: primaryLabel,
				statusName: config.pick_from,
			},
		);

		// Client-side filter: ensure issue has ALL configured labels (AND logic)
		const filtered =
			labels.length > 1
				? data.issues.nodes.filter((issue) => {
						const issueLabels = new Set(issue.labels.nodes.map((l) => l.name.toLowerCase()));
						return labels.every((l) => issueLabels.has(l.toLowerCase()));
					})
				: data.issues.nodes;

		return filtered.map((issue) => ({
			id: issue.identifier,
			title: issue.title,
			description: issue.description || "",
			url: issue.url,
		}));
	}

	async addLabel(issueId: string, labelName: string): Promise<void> {
		// Fetch issue with current labels and team labels
		const issueData = await gql<{
			issue: {
				id: string;
				team: { id: string; labels: { nodes: { id: string; name: string }[] } };
				labels: { nodes: { id: string; name: string }[] };
			};
		}>(
			`query($identifier: String!) {
				issue(id: $identifier) {
					id
					team {
						id
						labels { nodes { id name } }
					}
					labels { nodes { id name } }
				}
			}`,
			{ identifier: issueId },
		);

		// Find label in team labels — auto-create if missing
		let teamLabel = issueData.issue.team.labels.nodes.find(
			(l) => l.name.toLowerCase() === labelName.toLowerCase(),
		);

		if (!teamLabel) {
			const created = await gql<{
				issueLabelCreate: { success: boolean; issueLabel: { id: string; name: string } | null };
			}>(
				`mutation($teamId: String!, $name: String!) {
					issueLabelCreate(input: { teamId: $teamId, name: $name }) {
						success
						issueLabel { id name }
					}
				}`,
				{ teamId: issueData.issue.team.id, name: labelName },
			);

			if (created.issueLabelCreate.success && created.issueLabelCreate.issueLabel) {
				logger.log(`Label "${labelName}" created automatically in team ${issueData.issue.team.id}`);
				teamLabel = created.issueLabelCreate.issueLabel;
			} else {
				// Race condition: label may have been created by another process — refetch
				const refetch = await gql<{
					issue: { team: { labels: { nodes: { id: string; name: string }[] } } };
				}>(
					`query($identifier: String!) {
						issue(id: $identifier) {
							team { labels { nodes { id name } } }
						}
					}`,
					{ identifier: issueId },
				);
				teamLabel = refetch.issue.team.labels.nodes.find(
					(l) => l.name.toLowerCase() === labelName.toLowerCase(),
				);
				if (!teamLabel) {
					throw new Error(`Failed to create or find label "${labelName}" in team`);
				}
			}
		}

		// Skip if issue already has this label
		const alreadyHasLabel = issueData.issue.labels.nodes.some(
			(l) => l.name.toLowerCase() === labelName.toLowerCase(),
		);
		if (alreadyHasLabel) return;

		const newLabelIds = [...issueData.issue.labels.nodes.map((l) => l.id), teamLabel.id];

		const mutationResult = await gql<{
			issueUpdate: { success: boolean };
		}>(
			`mutation($issueId: String!, $labelIds: [String!]!) {
				issueUpdate(id: $issueId, input: { labelIds: $labelIds }) {
					success
				}
			}`,
			{
				issueId: issueData.issue.id,
				labelIds: newLabelIds,
			},
		);

		if (!mutationResult.issueUpdate.success) {
			throw new Error(
				`issueUpdate returned success=false when adding label "${labelName}" to ${issueId}`,
			);
		}
	}

	async listProjects(scope: string): Promise<{ value: string; label: string }[]> {
		const data = await gql<{
			teams: { nodes: { id: string }[] };
		}>(
			`query($teamName: String!) {
				teams(filter: { name: { eq: $teamName } }) {
					nodes { id }
				}
			}`,
			{ teamName: scope },
		);

		const team = data.teams.nodes[0];
		if (!team) throw new Error(`Team "${scope}" not found`);

		const projectData = await gql<{
			projects: { nodes: { name: string }[] };
		}>(
			`query($teamId: ID!) {
				projects(filter: { accessibleTeams: { id: { eq: $teamId } } }) {
					nodes { name }
				}
			}`,
			{ teamId: team.id },
		);

		return projectData.projects.nodes.map((p) => ({ value: p.name, label: p.name }));
	}

	async listStatuses(scope: string): Promise<{ value: string; label: string }[]> {
		const data = await gql<{
			teams: { nodes: { id: string }[] };
		}>(
			`query($teamName: String!) {
				teams(filter: { name: { eq: $teamName } }) {
					nodes { id }
				}
			}`,
			{ teamName: scope },
		);

		const team = data.teams.nodes[0];
		if (!team) throw new Error(`Team "${scope}" not found`);

		const statesData = await gql<{
			workflowStates: { nodes: { name: string; type: string }[] };
		}>(
			`query($teamId: ID!) {
				workflowStates(filter: { team: { id: { eq: $teamId } } }) {
					nodes { name type }
				}
			}`,
			{ teamId: team.id },
		);

		return statesData.workflowStates.nodes.map((s) => ({
			value: s.name,
			label: `${s.name} (${s.type})`,
		}));
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

		const mutationResult = await gql<{
			issueUpdate: { success: boolean };
		}>(
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

		if (!mutationResult.issueUpdate.success) {
			throw new Error(
				`issueUpdate returned success=false when removing label "${labelName}" from ${issueId}`,
			);
		}
	}

	async createIssue(opts: CreateIssueOpts, config: SourceConfig): Promise<string> {
		// Resolve team ID from team name (config.scope)
		const teamData = await gql<{
			teams: { nodes: { id: string }[] };
		}>(
			`query($teamName: String!) {
				teams(filter: { name: { eq: $teamName } }) {
					nodes { id }
				}
			}`,
			{ teamName: config.scope },
		);
		const team = teamData.teams.nodes[0];
		if (!team) throw new Error(`Team "${config.scope}" not found`);

		// Resolve state ID from status name
		const statesData = await gql<{
			workflowStates: { nodes: { id: string; name: string }[] };
		}>(
			`query($teamId: ID!) {
				workflowStates(filter: { team: { id: { eq: $teamId } } }) {
					nodes { id name }
				}
			}`,
			{ teamId: team.id },
		);
		const state = statesData.workflowStates.nodes.find(
			(s) => s.name.toLowerCase() === opts.status.toLowerCase(),
		);
		if (!state) {
			const available = statesData.workflowStates.nodes.map((s) => s.name).join(", ");
			throw new Error(`Status "${opts.status}" not found. Available: ${available}`);
		}

		// Resolve label IDs from label names
		const labelNames = Array.isArray(opts.label) ? opts.label : [opts.label];
		const teamLabelsData = await gql<{
			teams: { nodes: { labels: { nodes: { id: string; name: string }[] } }[] };
		}>(
			`query($teamName: String!) {
				teams(filter: { name: { eq: $teamName } }) {
					nodes { labels { nodes { id name } } }
				}
			}`,
			{ teamName: config.scope },
		);
		const teamLabels = teamLabelsData.teams.nodes[0]?.labels.nodes ?? [];
		const labelIds: string[] = [];
		for (const name of labelNames) {
			const label = teamLabels.find((l) => l.name.toLowerCase() === name.toLowerCase());
			if (!label) throw new Error(`Label "${name}" not found in team "${config.scope}"`);
			labelIds.push(label.id);
		}

		// Build mutation input
		const input: Record<string, unknown> = {
			teamId: team.id,
			title: opts.title,
			description: opts.description,
			stateId: state.id,
			labelIds,
		};
		if (opts.order !== undefined) input.priority = opts.order;
		if (opts.parentId) input.parentId = opts.parentId;

		const result = await gql<{
			issueCreate: { success: boolean; issue: { identifier: string } | null };
		}>(
			`mutation($input: IssueCreateInput!) {
				issueCreate(input: $input) {
					success
					issue { identifier }
				}
			}`,
			{ input },
		);

		if (!result.issueCreate.success || !result.issueCreate.issue) {
			throw new Error("issueCreate returned success=false");
		}

		return result.issueCreate.issue.identifier;
	}

	async linkDependency(issueId: string, dependsOnId: string): Promise<void> {
		// Resolve both issue internal IDs
		const issueData = await gql<{ issue: { id: string } }>(
			`query($identifier: String!) { issue(id: $identifier) { id } }`,
			{ identifier: dependsOnId },
		);
		const dependentData = await gql<{ issue: { id: string } }>(
			`query($identifier: String!) { issue(id: $identifier) { id } }`,
			{ identifier: issueId },
		);

		// "blocks" means dependsOnId blocks issueId
		await gql<{ issueRelationCreate: { success: boolean } }>(
			`mutation($issueId: String!, $relatedIssueId: String!, $type: String!) {
				issueRelationCreate(input: { issueId: $issueId, relatedIssueId: $relatedIssueId, type: $type }) {
					success
				}
			}`,
			{
				issueId: dependentData.issue.id,
				relatedIssueId: issueData.issue.id,
				type: "blocks",
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
