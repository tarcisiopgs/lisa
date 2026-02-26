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
	skipped?: boolean;
	killed?: boolean;
	pausedAt?: number;
	pauseAccumulated?: number;
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
						? {
								...c,
								column: "in_progress" as const,
								startedAt: Date.now(),
								hasError: false,
								skipped: false,
								killed: false,
								pausedAt: undefined,
								pauseAccumulated: 0,
							}
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

		const onSkipped = (issueId: string) => {
			setCards((prev) =>
				prev.map((c) =>
					c.id === issueId
						? {
								...c,
								column: "backlog" as const,
								startedAt: undefined,
								skipped: true,
								hasError: false,
								pausedAt: undefined,
							}
						: c,
				),
			);
		};

		const onKilled = (issueId: string) => {
			setCards((prev) =>
				prev.map((c) =>
					c.id === issueId
						? {
								...c,
								column: "backlog" as const,
								startedAt: undefined,
								killed: true,
								hasError: false,
								pausedAt: undefined,
							}
						: c,
				),
			);
		};

		const onProviderPaused = (issueId?: string) => {
			setCards((prev) =>
				prev.map((c) => {
					if (c.column !== "in_progress") return c;
					if (issueId && c.id !== issueId) return c;
					return { ...c, pausedAt: Date.now() };
				}),
			);
		};

		const onProviderResumed = (issueId?: string) => {
			setCards((prev) =>
				prev.map((c) => {
					if (c.column !== "in_progress" || !c.pausedAt) return c;
					if (issueId && c.id !== issueId) return c;
					const pauseDuration = Date.now() - c.pausedAt;
					return {
						...c,
						pausedAt: undefined,
						pauseAccumulated: (c.pauseAccumulated ?? 0) + pauseDuration,
					};
				}),
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
		kanbanEmitter.on("issue:skipped", onSkipped);
		kanbanEmitter.on("issue:killed", onKilled);
		kanbanEmitter.on("provider:paused", onProviderPaused);
		kanbanEmitter.on("provider:resumed", onProviderResumed);
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
			kanbanEmitter.off("issue:skipped", onSkipped);
			kanbanEmitter.off("issue:killed", onKilled);
			kanbanEmitter.off("provider:paused", onProviderPaused);
			kanbanEmitter.off("provider:resumed", onProviderResumed);
			kanbanEmitter.off("issue:output", onOutput);
			kanbanEmitter.off("work:empty", onEmpty);
			kanbanEmitter.off("work:complete", onComplete);
		};
	}, []);

	return { cards, isEmpty, workComplete };
}
