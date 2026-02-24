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
	outputLog: string;
}

export interface KanbanStateData {
	cards: KanbanCard[];
	isEmpty: boolean;
	workComplete: { total: number; duration: number } | null;
}

class KanbanEmitter extends EventEmitter {}

export const kanbanEmitter = new KanbanEmitter();

export function useKanbanState(): KanbanStateData {
	const [cards, setCards] = useState<KanbanCard[]>([]);
	const [isEmpty, setIsEmpty] = useState(false);
	const [workComplete, setWorkComplete] = useState<{ total: number; duration: number } | null>(
		null,
	);

	useEffect(() => {
		const onQueued = (issue: Issue) => {
			setCards((prev) => {
				if (prev.some((c) => c.id === issue.id)) return prev;
				return [...prev, { id: issue.id, title: issue.title, column: "backlog", outputLog: "" }];
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

		const onOutput = (issueId: string, text: string) => {
			setCards((prev) =>
				prev.map((c) => (c.id === issueId ? { ...c, outputLog: c.outputLog + text } : c)),
			);
		};

		kanbanEmitter.on("issue:queued", onQueued);
		kanbanEmitter.on("issue:started", onStarted);
		kanbanEmitter.on("issue:done", onDone);
		kanbanEmitter.on("issue:reverted", onReverted);
		kanbanEmitter.on("issue:output", onOutput);

		const onEmpty = () => setIsEmpty(true);
		const onComplete = (data: { total: number; duration: number }) => setWorkComplete(data);
		kanbanEmitter.on("work:empty", onEmpty);
		kanbanEmitter.on("work:complete", onComplete);

		return () => {
			kanbanEmitter.off("issue:queued", onQueued);
			kanbanEmitter.off("issue:started", onStarted);
			kanbanEmitter.off("issue:done", onDone);
			kanbanEmitter.off("issue:reverted", onReverted);
			kanbanEmitter.off("issue:output", onOutput);
			kanbanEmitter.off("work:empty", onEmpty);
			kanbanEmitter.off("work:complete", onComplete);
		};
	}, []);

	return { cards, isEmpty, workComplete };
}
