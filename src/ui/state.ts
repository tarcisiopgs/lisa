import { EventEmitter } from "node:events";
import { useEffect, useState } from "react";
import type { Issue } from "../types/index.js";

export interface KanbanCard {
	id: string;
	title: string;
	column: "backlog" | "in_progress" | "done";
	startedAt?: number;
	finishedAt?: number;
	prUrl?: string;
	hasError?: boolean;
}

export interface KanbanStateData {
	cards: KanbanCard[];
}

class KanbanEmitter extends EventEmitter {}

export const kanbanEmitter = new KanbanEmitter();

export function useKanbanState(): KanbanStateData {
	const [cards, setCards] = useState<KanbanCard[]>([]);

	useEffect(() => {
		const onQueued = (issue: Issue) => {
			setCards((prev) => {
				if (prev.some((c) => c.id === issue.id)) return prev;
				return [...prev, { id: issue.id, title: issue.title, column: "backlog" }];
			});
		};

		const onStarted = (issueId: string) => {
			setCards((prev) =>
				prev.map((c) =>
					c.id === issueId
						? { ...c, column: "in_progress" as const, startedAt: Date.now(), hasError: false }
						: c,
				),
			);
		};

		const onDone = (issueId: string, prUrl: string) => {
			setCards((prev) =>
				prev.map((c) =>
					c.id === issueId ? { ...c, column: "done" as const, prUrl, finishedAt: Date.now() } : c,
				),
			);
		};

		const onReverted = (issueId: string) => {
			setCards((prev) =>
				prev.map((c) =>
					c.id === issueId
						? { ...c, column: "backlog" as const, startedAt: undefined, hasError: true }
						: c,
				),
			);
		};

		kanbanEmitter.on("issue:queued", onQueued);
		kanbanEmitter.on("issue:started", onStarted);
		kanbanEmitter.on("issue:done", onDone);
		kanbanEmitter.on("issue:reverted", onReverted);

		return () => {
			kanbanEmitter.off("issue:queued", onQueued);
			kanbanEmitter.off("issue:started", onStarted);
			kanbanEmitter.off("issue:done", onDone);
			kanbanEmitter.off("issue:reverted", onReverted);
		};
	}, []);

	return { cards };
}
