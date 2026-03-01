import * as logger from "../output/logger.js";
import type { Issue, Source, SourceConfig } from "../types/index.js";

const API_BASE_URL = "https://api.app.shortcut.com";
const REQUEST_TIMEOUT_MS = 30_000;

function getAuthHeaders(): Record<string, string> {
	const token = process.env.SHORTCUT_API_TOKEN;
	if (!token) throw new Error("SHORTCUT_API_TOKEN must be set");
	return { "Shortcut-Token": token, "Content-Type": "application/json" };
}

async function shortcutFetch<T>(method: string, path: string, body?: unknown): Promise<T> {
	const url = `${API_BASE_URL}${path}`;
	const res = await fetch(url, {
		method,
		headers: getAuthHeaders(),
		body: body !== undefined ? JSON.stringify(body) : undefined,
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Shortcut API error (${res.status}): ${text}`);
	}
	if (method === "DELETE" || res.status === 204) return undefined as T;
	return (await res.json()) as T;
}

async function shortcutGet<T>(path: string): Promise<T> {
	return shortcutFetch<T>("GET", path);
}

async function shortcutPost<T>(path: string, body: unknown): Promise<T> {
	return shortcutFetch<T>("POST", path, body);
}

async function shortcutPut<T>(path: string, body: unknown): Promise<T> {
	return shortcutFetch<T>("PUT", path, body);
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
		const labelNames = Array.isArray(config.label) ? config.label : [config.label];
		const primaryLabel = labelNames[0] ?? "";
		const labelIds = await Promise.all(labelNames.map((name) => resolveLabelId(name)));

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
			const searchResult = await shortcutPost<ShortcutStorySearchResult>("/api/v3/stories/search", {
				workflow_state_id: stateId,
				label_name: primaryLabel,
				archived: false,
			});
			for (const story of searchResult.data ?? []) {
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
				} catch {
					// If we can't fetch, assume still active
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
			return {
				id: String(story.id),
				title: story.name,
				description: story.description ?? "",
				url: story.app_url,
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
		const labelNames = Array.isArray(config.label) ? config.label : [config.label];
		const primaryLabel = labelNames[0] ?? "";
		const labelIds = await Promise.all(labelNames.map((name) => resolveLabelId(name)));

		// Search stories per workflow state (API only accepts singular workflow_state_id)
		const seen = new Set<number>();
		const allStories: ShortcutStory[] = [];
		for (const stateId of stateIds) {
			const searchResult = await shortcutPost<ShortcutStorySearchResult>("/api/v3/stories/search", {
				workflow_state_id: stateId,
				label_name: primaryLabel,
				archived: false,
			});
			for (const story of searchResult.data ?? []) {
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

	async removeLabel(storyId: string, labelName: string): Promise<void> {
		const story = await shortcutGet<ShortcutStory>(`/api/v3/stories/${storyId}`);
		const labels = await shortcutGet<ShortcutLabel[]>("/api/v3/labels");
		const label = labels.find(
			(l) => l.name.toLowerCase() === labelName.toLowerCase() && !l.archived,
		);

		if (!label || !story.label_ids.includes(label.id)) return;

		const updatedLabelIds = story.label_ids.filter((lid) => lid !== label.id);
		await shortcutPut<ShortcutStory>(`/api/v3/stories/${storyId}`, {
			label_ids: updatedLabelIds,
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
