import * as logger from "../output/logger.js";
import type { CreateIssueOpts, Issue, Source, SourceConfig } from "../types/index.js";
import { normalizeLabels, REQUEST_TIMEOUT_MS } from "./base.js";

const API_URL = "https://api.trello.com/1";

function getAuthHeaders(): Record<string, string> {
	const key = process.env.TRELLO_API_KEY;
	const token = process.env.TRELLO_TOKEN;
	if (!key || !token) throw new Error("TRELLO_API_KEY and TRELLO_TOKEN must be set");
	return {
		Authorization: `OAuth oauth_consumer_key="${key}", oauth_token="${token}"`,
	};
}

async function trelloFetch<T>(method: string, path: string, params = ""): Promise<T> {
	const sep = params ? "?" : "";
	const url = `${API_URL}${path}${sep}${params}`;
	const res = await fetch(url, {
		method,
		headers: getAuthHeaders(),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Trello API error (${res.status}): ${text}`);
	}
	if (method === "DELETE") return undefined as T;
	return (await res.json()) as T;
}

async function trelloGet<T>(path: string, params = ""): Promise<T> {
	return trelloFetch<T>("GET", path, params);
}

async function trelloPut<T>(path: string, params = ""): Promise<T> {
	return trelloFetch<T>("PUT", path, params);
}

async function trelloPost<T>(path: string, params = ""): Promise<T> {
	return trelloFetch<T>("POST", path, params);
}

async function trelloDelete(path: string): Promise<void> {
	await trelloFetch<void>("DELETE", path);
}

interface TrelloBoard {
	id: string;
	name: string;
}

interface TrelloList {
	id: string;
	name: string;
}

interface TrelloLabel {
	id: string;
	name: string;
}

interface TrelloCard {
	id: string;
	name: string;
	desc: string;
	url: string;
	idLabels: string[];
	idList: string;
}

async function findBoardByName(name: string): Promise<TrelloBoard> {
	const boards = await trelloGet<TrelloBoard[]>("/members/me/boards", "fields=name");
	const board = boards.find((b) => b.name.toLowerCase() === name.toLowerCase());
	if (!board) throw new Error(`Trello board "${name}" not found`);
	return board;
}

async function findListByName(boardId: string, name: string): Promise<TrelloList> {
	const lists = await trelloGet<TrelloList[]>(`/boards/${boardId}/lists`, "fields=name");
	const list = lists.find((l) => l.name.toLowerCase() === name.toLowerCase());
	if (!list) {
		const available = lists.map((l) => l.name).join(", ");
		throw new Error(`Trello list "${name}" not found. Available: ${available}`);
	}
	return list;
}

async function findLabelByName(boardId: string, name: string): Promise<TrelloLabel> {
	const labels = await trelloGet<TrelloLabel[]>(`/boards/${boardId}/labels`, "fields=name");
	const label = labels.find((l) => l.name.toLowerCase() === name.toLowerCase());
	if (!label) throw new Error(`Trello label "${name}" not found`);
	return label;
}

export class TrelloSource implements Source {
	name = "trello" as const;

	async fetchNextIssue(config: SourceConfig): Promise<Issue | null> {
		const board = await findBoardByName(config.scope);
		const list = await findListByName(board.id, config.pick_from);
		const labelNames = normalizeLabels(config);
		const labelIds = await resolveLabelsWithWarnings(board.id, labelNames);

		const cards = await trelloGet<TrelloCard[]>(
			`/lists/${list.id}/cards`,
			"fields=name,desc,url,idLabels,idList",
		);

		const matching = cards.filter((c) => labelIds.every((lid) => c.idLabels.includes(lid)));
		if (matching.length === 0) return null;

		const card = matching[0];
		if (!card) return null;
		return {
			id: card.id,
			title: card.name,
			description: card.desc || "",
			url: card.url,
		};
	}

	async fetchIssueById(id: string): Promise<Issue | null> {
		const shortLink = parseTrelloIdentifier(id);

		try {
			const card = await trelloGet<TrelloCard & { list?: { name: string } }>(
				`/cards/${shortLink}`,
				"fields=name,desc,url,idLabels,idList&list=true&list_fields=name",
			);

			return {
				id: card.id,
				title: card.name,
				description: card.desc || "",
				url: card.url,
				status: card.list?.name,
			};
		} catch {
			return null;
		}
	}

	async updateStatus(cardId: string, listName: string): Promise<void> {
		// Get the card to find its board
		const card = await trelloGet<{ idBoard: string }>(`/cards/${cardId}`, "fields=idBoard");
		const list = await findListByName(card.idBoard, listName);
		await trelloPut(`/cards/${cardId}`, `idList=${list.id}`);
	}

	async attachPullRequest(cardId: string, prUrl: string): Promise<void> {
		await trelloPost(`/cards/${cardId}/attachments`, `url=${encodeURIComponent(prUrl)}`);
	}

	async completeIssue(cardId: string, listName: string, labelToRemove?: string): Promise<void> {
		await this.updateStatus(cardId, listName);
		if (labelToRemove) {
			await this.removeLabel(cardId, labelToRemove);
		}
	}

	async listIssues(config: SourceConfig): Promise<Issue[]> {
		const board = await findBoardByName(config.scope);
		const list = await findListByName(board.id, config.pick_from);
		const labelNames = normalizeLabels(config);
		const labelIds = await resolveLabelsWithWarnings(board.id, labelNames);

		const cards = await trelloGet<TrelloCard[]>(
			`/lists/${list.id}/cards`,
			"fields=name,desc,url,idLabels,idList",
		);

		return cards
			.filter((c) => labelIds.every((lid) => c.idLabels.includes(lid)))
			.map((c) => ({
				id: c.id,
				title: c.name,
				description: c.desc || "",
				url: c.url,
			}));
	}

	async listScopes(): Promise<{ value: string; label: string }[]> {
		const boards = await trelloGet<TrelloBoard[]>("/members/me/boards", "fields=name");
		return boards.map((b) => ({ value: b.name, label: b.name }));
	}

	async listLabels(scope: string): Promise<{ value: string; label: string }[]> {
		const board = await findBoardByName(scope);
		const labels = await trelloGet<TrelloLabel[]>(`/boards/${board.id}/labels`, "fields=name");
		return labels.filter((l) => l.name.length > 0).map((l) => ({ value: l.name, label: l.name }));
	}

	async listStatuses(scope: string): Promise<{ value: string; label: string }[]> {
		const board = await findBoardByName(scope);
		const lists = await trelloGet<TrelloList[]>(`/boards/${board.id}/lists`, "fields=name");
		return lists.map((l) => ({ value: l.name, label: l.name }));
	}

	async removeLabel(cardId: string, labelName: string): Promise<void> {
		const card = await trelloGet<{ idBoard: string; idLabels: string[] }>(
			`/cards/${cardId}`,
			"fields=idBoard,idLabels",
		);
		const label = await findLabelByName(card.idBoard, labelName);

		if (!card.idLabels.includes(label.id)) return;
		await trelloDelete(`/cards/${cardId}/idLabels/${label.id}`);
	}

	async createIssue(opts: CreateIssueOpts, config: SourceConfig): Promise<string> {
		const board = await findBoardByName(config.scope);
		const list = await findListByName(board.id, opts.status);

		// Resolve label IDs
		const labelNames = Array.isArray(opts.label) ? opts.label : [opts.label];
		const labelIds = await resolveLabelsWithWarnings(board.id, labelNames);

		const params = [
			`idList=${list.id}`,
			`name=${encodeURIComponent(opts.title)}`,
			`desc=${encodeURIComponent(opts.description)}`,
			`pos=${opts.order ?? "bottom"}`,
			...labelIds.map((id) => `idLabels=${id}`),
		].join("&");

		const card = await trelloPost<{ id: string }>("/cards", params);
		return card.id;
	}
}

async function resolveLabelsWithWarnings(boardId: string, names: string[]): Promise<string[]> {
	const results = await Promise.allSettled(
		names.map((name) => findLabelByName(boardId, name).then((l) => l.id)),
	);

	const resolved: string[] = [];
	const failed: string[] = [];

	for (let i = 0; i < results.length; i++) {
		const result = results[i]!;
		if (result.status === "fulfilled") {
			resolved.push(result.value);
		} else {
			failed.push(names[i]!);
		}
	}

	if (failed.length > 0 && resolved.length > 0) {
		logger.warn(`Failed to resolve Trello labels: ${failed.join(", ")}`);
	}

	if (failed.length > 0 && resolved.length === 0) {
		throw new Error(
			`All Trello label resolutions failed: ${failed.join(", ")}. Cannot match issues without labels.`,
		);
	}

	return resolved;
}

function parseTrelloIdentifier(input: string): string {
	// Extract shortLink from Trello URL: https://trello.com/c/H0TZyzbK/title
	const urlMatch = input.match(/\/c\/([a-zA-Z0-9]+)/);
	if (urlMatch?.[1]) return urlMatch[1];

	// Already a shortLink like H0TZyzbK
	return input;
}
