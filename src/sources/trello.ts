import type { Issue, Source, SourceConfig } from "../types.js";

const API_URL = "https://api.trello.com/1";
const REQUEST_TIMEOUT_MS = 30_000;

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
		const board = await findBoardByName(config.team);
		const list = await findListByName(board.id, config.project);
		const label = await findLabelByName(board.id, config.label);

		const cards = await trelloGet<TrelloCard[]>(
			`/lists/${list.id}/cards`,
			"fields=name,desc,url,idLabels,idList",
		);

		const matching = cards.filter((c) => c.idLabels.includes(label.id));
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
			const card = await trelloGet<TrelloCard>(
				`/cards/${shortLink}`,
				"fields=name,desc,url,idLabels,idList",
			);

			return {
				id: card.id,
				title: card.name,
				description: card.desc || "",
				url: card.url,
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

	async removeLabel(cardId: string, labelName: string): Promise<void> {
		const card = await trelloGet<{ idBoard: string; idLabels: string[] }>(
			`/cards/${cardId}`,
			"fields=idBoard,idLabels",
		);
		const label = await findLabelByName(card.idBoard, labelName);

		if (!card.idLabels.includes(label.id)) return;
		await trelloDelete(`/cards/${cardId}/idLabels/${label.id}`);
	}
}

function parseTrelloIdentifier(input: string): string {
	// Extract shortLink from Trello URL: https://trello.com/c/H0TZyzbK/title
	const urlMatch = input.match(/\/c\/([a-zA-Z0-9]+)/);
	if (urlMatch?.[1]) return urlMatch[1];

	// Already a shortLink like H0TZyzbK
	return input;
}
