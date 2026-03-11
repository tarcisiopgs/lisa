import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getKanbanStatePath } from "../paths.js";
import type { KanbanCard } from "../ui/state.js";
import { kanbanEmitter } from "../ui/state.js";

const STATE_VERSION = 1 as const;
const OUTPUT_TAIL_LINES = 100;

interface PersistedCard {
	id: string;
	title: string;
	column: "backlog" | "in_progress" | "done";
	startedAt?: number;
	finishedAt?: number;
	prUrls: string[];
	hasError?: boolean;
	skipped?: boolean;
	killed?: boolean;
	merged?: boolean;
	logFile?: string;
	outputLogTail: string[];
}

interface PersistedKanbanState {
	version: typeof STATE_VERSION;
	cards: PersistedCard[];
	updatedAt: number;
}

function resolveCard(card: PersistedCard): KanbanCard {
	if (card.column === "in_progress") {
		if (card.prUrls.length > 0) {
			return {
				id: card.id,
				title: card.title,
				column: "done",
				startedAt: card.startedAt,
				finishedAt: card.finishedAt ?? Date.now(),
				prUrls: card.prUrls,
				merged: card.merged,
				logFile: card.logFile,
				outputLog: card.outputLogTail.join("\n"),
			};
		}
		return {
			id: card.id,
			title: card.title,
			column: "backlog",
			prUrls: [],
			hasError: false,
			skipped: false,
			killed: false,
			outputLog: "",
		};
	}
	return {
		id: card.id,
		title: card.title,
		column: card.column,
		startedAt: card.startedAt,
		finishedAt: card.finishedAt,
		prUrls: card.prUrls,
		hasError: card.hasError,
		skipped: card.skipped,
		killed: card.killed,
		merged: card.merged,
		logFile: card.logFile,
		outputLog: card.outputLogTail.join("\n"),
	};
}

class KanbanPersistence {
	private state: PersistedKanbanState;
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly statePath: string;
	private readonly handlers: Array<{ event: string; handler: (...args: unknown[]) => void }> = [];

	constructor(workspace: string) {
		this.statePath = getKanbanStatePath(workspace);
		this.state = { version: STATE_VERSION, cards: [], updatedAt: Date.now() };
	}

	load(): KanbanCard[] {
		if (!existsSync(this.statePath)) return [];

		let raw: string;
		try {
			raw = readFileSync(this.statePath, "utf-8");
		} catch {
			return [];
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			console.warn(
				"[lisa] kanban-state.json is corrupted — resetting. Backup saved to kanban-state.json.bak",
			);
			try {
				renameSync(this.statePath, `${this.statePath}.bak`);
			} catch {
				// ignore rename errors
			}
			return [];
		}

		const data = parsed as PersistedKanbanState;
		if (!data || data.version !== STATE_VERSION) return [];

		this.state = data;
		return data.cards.map(resolveCard);
	}

	start(): void {
		const on = <T extends unknown[]>(event: string, handler: (...args: T) => void) => {
			kanbanEmitter.on(event, handler as (...args: unknown[]) => void);
			this.handlers.push({ event, handler: handler as (...args: unknown[]) => void });
		};

		on("issue:queued", (issue: { id: string; title: string }) => {
			this.upsertCard(issue.id, issue.title);
			this.scheduleFlush();
		});

		on("issue:started", (issueId: string) => {
			this.updateCard(issueId, {
				column: "in_progress",
				startedAt: Date.now(),
				prUrls: [],
				hasError: false,
				skipped: false,
				killed: false,
				outputLogTail: [],
			});
			this.scheduleFlush();
		});

		on("issue:done", (issueId: string, prUrls: string[]) => {
			this.updateCard(issueId, { column: "done", prUrls, finishedAt: Date.now() });
			this.scheduleFlush();
		});

		on("issue:merged", (issueId: string) => {
			this.updateCard(issueId, { merged: true });
			this.scheduleFlush();
		});

		on("issue:reverted", (issueId: string) => {
			this.updateCard(issueId, { column: "backlog", startedAt: undefined, hasError: true });
			this.scheduleFlush();
		});

		on("issue:skipped", (issueId: string) => {
			this.updateCard(issueId, { column: "backlog", startedAt: undefined, skipped: true });
			this.scheduleFlush();
		});

		on("issue:killed", (issueId: string) => {
			this.updateCard(issueId, { column: "backlog", startedAt: undefined, killed: true });
			this.scheduleFlush();
		});

		on("issue:log-file", (issueId: string, logFile: string) => {
			this.updateCard(issueId, { logFile });
			this.scheduleFlush();
		});

		on("issue:output", (issueId: string, text: string) => {
			this.appendOutput(issueId, text);
			this.scheduleFlush();
		});
	}

	stop(): void {
		for (const { event, handler } of this.handlers) {
			kanbanEmitter.off(event, handler);
		}
		this.handlers.length = 0;

		if (this.flushTimer !== null) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		this.flush();
	}

	private scheduleFlush(): void {
		if (this.flushTimer !== null) clearTimeout(this.flushTimer);
		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;
			this.flush();
		}, 500);
	}

	private flush(): void {
		this.state.updatedAt = Date.now();
		const dir = dirname(this.statePath);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(this.statePath, JSON.stringify(this.state));
	}

	private upsertCard(id: string, title: string): void {
		if (!this.state.cards.some((c) => c.id === id)) {
			this.state.cards.push({ id, title, column: "backlog", prUrls: [], outputLogTail: [] });
		}
	}

	private updateCard(id: string, patch: Partial<PersistedCard>): void {
		const idx = this.state.cards.findIndex((c) => c.id === id);
		if (idx !== -1) {
			this.state.cards[idx] = { ...this.state.cards[idx], ...patch };
		}
	}

	private appendOutput(id: string, text: string): void {
		const idx = this.state.cards.findIndex((c) => c.id === id);
		if (idx === -1) return;
		const card = this.state.cards[idx];
		const newLines = text.split("\n");
		const combined = [...card.outputLogTail, ...newLines];
		card.outputLogTail = combined.slice(-OUTPUT_TAIL_LINES);
	}
}

export function createKanbanPersistence(workspace: string): KanbanPersistence {
	return new KanbanPersistence(workspace);
}
