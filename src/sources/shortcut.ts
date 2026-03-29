import { formatError, SourceError } from "../errors.js";
import * as logger from "../output/logger.js";
import type { CreateIssueOpts, Issue, Source, SourceConfig } from "../types/index.js";
import { createApiClient, normalizeLabels } from "./base.js";

function getAuthHeaders(): Record<string, string> {
	const token = process.env.SHORTCUT_API_TOKEN;
	if (!token) throw new SourceError("SHORTCUT_API_TOKEN must be set", "shortcut");
	return { "Shortcut-Token": token };
}

let _api: ReturnType<typeof createApiClient> | null = null;

function api() {
	if (!_api) _api = createApiClient("https://api.app.shortcut.com", getAuthHeaders, "Shortcut");
	return _api;
}

function shortcutGet<T>(path: string): Promise<T> {
	return api().get<T>(path);
}

function shortcutPost<T>(path: string, body: unknown): Promise<T> {
	return api().post<T>(path, body);
}

function shortcutPut<T>(path: string, body: unknown): Promise<T> {
	return api().put<T>(path, body);
}

interface ShortcutWorkflowState {
	id: number;
	name: string;
	type: string;
}

interface ShortcutWorkflow {
	id: number;
	name: string;
	states: ShortcutWorkflowState[];
}

interface ShortcutLabel {
	id: number;
	name: string;
	color: string | null;
	archived: boolean;
}

interface ShortcutStoryLink {
	id: number;
	subject_id: number;
	object_id: number;
	verb: string;
}

interface ShortcutStory {
	id: number;
	name: string;
	description: string;
	app_url: string;
	workflow_state_id: number;
	label_ids: number[];
	position: number;
	priority: number | null;
	story_links: ShortcutStoryLink[];
}

interface ShortcutStorySearchResult {
	data: ShortcutStory[];
	next: string | null;
}

// The search API may return either { data: [...] } or a plain array depending on the version.
function extractStories(result: ShortcutStorySearchResult | ShortcutStory[]): ShortcutStory[] {
	if (Array.isArray(result)) return result;
	return result.data ?? [];
}

function extractNext(result: ShortcutStorySearchResult | ShortcutStory[]): string | null {
	if (Array.isArray(result)) return null;
	return result.next ?? null;
}

async function searchStoriesAll(body: Record<string, unknown>): Promise<ShortcutStory[]> {
	const all: ShortcutStory[] = [];
	let next: string | null = null;
	do {
		const req = next ? { ...body, next } : body;
		const result = await shortcutPost<ShortcutStorySearchResult | ShortcutStory[]>(
			"/api/v3/stories/search",
			req,
		);
		all.push(...extractStories(result));
		next = extractNext(result);
	} while (next);
	return all;
}

interface ShortcutComment {
	id: number;
	text: string;
}

async function resolveWorkflowStateId(stateName: string): Promise<number> {
	const workflows = await shortcutGet<ShortcutWorkflow[]>("/api/v3/workflows");
	for (const workflow of workflows) {
		const state = workflow.states.find((s) => s.name.toLowerCase() === stateName.toLowerCase());
		if (state) return state.id;
	}
	const allStates = workflows.flatMap((w) => w.states.map((s) => s.name));
	throw new Error(
		`Shortcut workflow state "${stateName}" not found. Available: ${allStates.join(", ")}`,
	);
}

async function resolveAllWorkflowStateIds(stateName: string): Promise<number[]> {
	const workflows = await shortcutGet<ShortcutWorkflow[]>("/api/v3/workflows");
	const ids: number[] = [];
	for (const workflow of workflows) {
		for (const state of workflow.states) {
			if (state.name.toLowerCase() === stateName.toLowerCase()) {
				ids.push(state.id);
			}
		}
	}
	if (ids.length === 0) {
		const allStates = workflows.flatMap((w) => w.states.map((s) => s.name));
		throw new Error(
			`Shortcut workflow state "${stateName}" not found. Available: ${allStates.join(", ")}`,
		);
	}
	return ids;
}

async function resolveLabelId(labelName: string): Promise<number> {
	const labels = await shortcutGet<ShortcutLabel[]>("/api/v3/labels");
	const label = labels.find((l) => l.name.toLowerCase() === labelName.toLowerCase() && !l.archived);
	if (!label) {
		const available = labels
			.filter((l) => !l.archived)
			.map((l) => l.name)
			.join(", ");
		throw new Error(`Shortcut label "${labelName}" not found. Available: ${available}`);
	}
	return label.id;
}

// Priority values in Shortcut: lower number = higher priority (1=p1, 2=p2, 3=p3, 4=p4)
// null means no priority (lowest)
function priorityRank(priority: number | null): number {
	if (priority === null) return Number.MAX_SAFE_INTEGER;
	return priority;
}

export class ShortcutSource implements Source {
	name = "shortcut" as const;

	async fetchNextIssue(config: SourceConfig): Promise<Issue | null> {
		const stateIds = await resolveAllWorkflowStateIds(config.pick_from);
		const labelNames = normalizeLabels(config);
		const primaryLabel = labelNames[0] ?? "";
		const labelIdResults = await Promise.allSettled(labelNames.map((name) => resolveLabelId(name)));
		const labelIds = labelIdResults
			.filter((r): r is PromiseFulfilledResult<number> => r.status === "fulfilled")
			.map((r) => r.value);

		// Resolve all workflow states to determine "done" states
		const workflows = await shortcutGet<ShortcutWorkflow[]>("/api/v3/workflows");
		const doneStateIds = new Set<number>();
		for (const workflow of workflows) {
			for (const state of workflow.states) {
				if (state.type === "done") {
					doneStateIds.add(state.id);
				}
			}
		}

		// Search stories per workflow state (API only accepts singular workflow_state_id)
		// and filter by primary label; deduplicate by story ID
		const seen = new Set<number>();
		const allStories: ShortcutStory[] = [];
		for (const stateId of stateIds) {
			for (const story of await searchStoriesAll({
				workflow_state_id: stateId,
				label_name: primaryLabel,
				archived: false,
			})) {
				if (!seen.has(story.id)) {
					seen.add(story.id);
					allStories.push(story);
				}
			}
		}

		// Client-side AND filter for additional labels
		const stories =
			labelIds.length > 1
				? allStories.filter((s) => labelIds.every((lid) => s.label_ids.includes(lid)))
				: allStories;

		if (stories.length === 0) return null;

		// Check blocking relations for each story
		const unblocked: ShortcutStory[] = [];
		const blocked: { id: number; name: string; blockers: number[] }[] = [];

		for (const story of stories) {
			const storyLinks = story.story_links ?? [];
			// "blocks" verb: subject_id blocks object_id
			// If this story is the object (object_id === story.id), the subject is blocking it
			const blockerIds = storyLinks
				.filter((link) => link.verb === "blocks" && link.object_id === story.id)
				.map((link) => link.subject_id);

			// Check if blockers are still active
			const activeBlockers: number[] = [];
			for (const blockerId of blockerIds) {
				try {
					const blocker = await shortcutGet<ShortcutStory>(`/api/v3/stories/${blockerId}`);
					if (!doneStateIds.has(blocker.workflow_state_id)) {
						activeBlockers.push(blockerId);
					}
				} catch (err) {
					// If we can't fetch, assume still active
					logger.warn(`Could not fetch blocker ${blockerId}: ${formatError(err)}`);
					activeBlockers.push(blockerId);
				}
			}

			if (activeBlockers.length === 0) {
				unblocked.push(story);
			} else {
				blocked.push({ id: story.id, name: story.name, blockers: activeBlockers });
			}
		}

		if (unblocked.length === 0) {
			if (blocked.length > 0) {
				logger.warn("No unblocked issues found. Blocked issues:");
				for (const entry of blocked) {
					logger.warn(
						`  #${entry.id} (${entry.name}) — blocked by: ${entry.blockers.map((b) => `#${b}`).join(", ")}`,
					);
				}
			}
			return null;
		}

		// Sort by priority ascending (lower = higher priority), then by position
		const sorted = [...unblocked].sort((a, b) => {
			const pa = priorityRank(a.priority);
			const pb = priorityRank(b.priority);
			if (pa !== pb) return pa - pb;
			return a.position - b.position;
		});

		const story = sorted[0];
		if (!story) return null;

		return {
			id: String(story.id),
			title: story.name,
			description: story.description ?? "",
			url: story.app_url,
		};
	}

	async fetchIssueById(id: string): Promise<Issue | null> {
		const storyId = parseShortcutIdentifier(id);
		try {
			const story = await shortcutGet<ShortcutStory>(`/api/v3/stories/${storyId}`);

			// Resolve workflow_state_id to state name (best-effort)
			let stateName: string | undefined;
			try {
				const workflows = await shortcutGet<ShortcutWorkflow[]>("/api/v3/workflows");
				for (const workflow of workflows) {
					const state = workflow.states.find((s) => s.id === story.workflow_state_id);
					if (state) {
						stateName = state.name;
						break;
					}
				}
			} catch {
				// Non-fatal — status resolution is best-effort
			}

			return {
				id: String(story.id),
				title: story.name,
				description: story.description ?? "",
				url: story.app_url,
				status: stateName,
			};
		} catch {
			return null;
		}
	}

	async updateStatus(storyId: string, stateName: string): Promise<void> {
		const stateId = await resolveWorkflowStateId(stateName);
		await shortcutPut<ShortcutStory>(`/api/v3/stories/${storyId}`, {
			workflow_state_id: stateId,
		});
	}

	async attachPullRequest(storyId: string, prUrl: string): Promise<void> {
		await shortcutPost<ShortcutComment>(`/api/v3/stories/${storyId}/comments`, {
			text: `Pull request: ${prUrl}`,
		});
	}

	async completeIssue(storyId: string, stateName: string, labelToRemove?: string): Promise<void> {
		await this.updateStatus(storyId, stateName);
		if (labelToRemove) {
			await this.removeLabel(storyId, labelToRemove);
		}
	}

	async listIssues(config: SourceConfig): Promise<Issue[]> {
		const stateIds = await resolveAllWorkflowStateIds(config.pick_from);
		const labelNames = normalizeLabels(config);
		const primaryLabel = labelNames[0] ?? "";
		const labelIdResults = await Promise.allSettled(labelNames.map((name) => resolveLabelId(name)));
		const labelIds = labelIdResults
			.filter((r): r is PromiseFulfilledResult<number> => r.status === "fulfilled")
			.map((r) => r.value);

		// Search stories per workflow state (API only accepts singular workflow_state_id)
		const seen = new Set<number>();
		const allStories: ShortcutStory[] = [];
		for (const stateId of stateIds) {
			for (const story of await searchStoriesAll({
				workflow_state_id: stateId,
				label_name: primaryLabel,
				archived: false,
			})) {
				if (!seen.has(story.id)) {
					seen.add(story.id);
					allStories.push(story);
				}
			}
		}

		// Client-side AND filter for additional labels
		const stories =
			labelIds.length > 1
				? allStories.filter((s) => labelIds.every((lid) => s.label_ids.includes(lid)))
				: allStories;

		return stories.map((story) => ({
			id: String(story.id),
			title: story.name,
			description: story.description ?? "",
			url: story.app_url,
		}));
	}

	async listStatuses(): Promise<{ value: string; label: string }[]> {
		const workflows = await shortcutGet<ShortcutWorkflow[]>("/api/v3/workflows");
		const seen = new Set<string>();
		const result: { value: string; label: string }[] = [];
		for (const workflow of workflows) {
			for (const state of workflow.states) {
				if (!seen.has(state.name)) {
					seen.add(state.name);
					result.push({ value: state.name, label: `${state.name} (${state.type})` });
				}
			}
		}
		return result;
	}

	async removeLabel(storyId: string, labelName: string): Promise<void> {
		const story = await shortcutGet<ShortcutStory>(`/api/v3/stories/${storyId}`);
		const allLabels = await shortcutGet<ShortcutLabel[]>("/api/v3/labels");
		const labelToRemove = allLabels.find(
			(l) => l.name.toLowerCase() === labelName.toLowerCase() && !l.archived,
		);

		if (!labelToRemove || !story.label_ids.includes(labelToRemove.id)) return;

		// Build remaining labels as { name } objects — Shortcut API requires `labels` not `label_ids`
		const remainingIds = story.label_ids.filter((lid) => lid !== labelToRemove.id);
		const labelNames = remainingIds
			.map((lid) => allLabels.find((l) => l.id === lid))
			.filter((l): l is ShortcutLabel => l !== undefined)
			.map((l) => ({ name: l.name }));

		await shortcutPut<ShortcutStory>(`/api/v3/stories/${storyId}`, {
			labels: labelNames,
		});
	}

	async createComment(issueId: string, body: string): Promise<string> {
		const storyId = parseShortcutIdentifier(issueId);
		const result = await shortcutPost<ShortcutComment>(`/api/v3/stories/${storyId}/comments`, {
			text: body,
		});
		return String(result.id);
	}

	async createIssue(opts: CreateIssueOpts, _config: SourceConfig): Promise<string> {
		const stateId = await resolveWorkflowStateId(opts.status);
		const labelNames = Array.isArray(opts.label) ? opts.label : [opts.label];

		const body: Record<string, unknown> = {
			name: opts.title,
			description: opts.description,
			workflow_state_id: stateId,
			labels: labelNames.map((name) => ({ name })),
		};
		if (opts.parentId) body.epic_id = Number(opts.parentId);

		const story = await shortcutPost<{ id: number; app_url: string }>("/api/v3/stories", body);

		return String(story.id);
	}

	async linkDependency(issueId: string, dependsOnId: string): Promise<void> {
		await shortcutPost("/api/v3/story-links", {
			subject_id: Number(dependsOnId),
			object_id: Number(issueId),
			verb: "blocks",
		});
	}
}

function parseShortcutIdentifier(input: string): string {
	// Extract story ID from Shortcut URL: https://app.shortcut.com/workspace/story/12345/...
	const urlMatch = input.match(/\/story\/(\d+)/);
	if (urlMatch?.[1]) return urlMatch[1];

	// Already a numeric ID
	return input;
}
