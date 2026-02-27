import { EventEmitter } from "node:events";
import { useEffect, useState } from "react";
import { notify } from "../output/terminal.js";
import { checkPrMerged as checkGitHubPrMerged } from "../sources/github-issues.js";
import { checkPrMerged as checkGitLabPrMerged } from "../sources/gitlab-issues.js";
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
	merged?: boolean;
}

const MERGE_POLL_INTERVAL_MS = 60_000;
const activePolls = new Map<string, ReturnType<typeof setInterval>>();

async function checkPrMergedByUrl(prUrl: string): Promise<boolean> {
	if (prUrl.includes("github.com")) {
		return checkGitHubPrMerged(prUrl);
	}
	if (prUrl.includes("gitlab")) {
		return checkGitLabPrMerged(prUrl);
	}
	return false;
}

function stopMergePolling(issueId: string): void {
	const interval = activePolls.get(issueId);
	if (interval !== undefined) {
		clearInterval(interval);
		activePolls.delete(issueId);
	}
}

function startMergePolling(issueId: string, prUrl: string): void {
	if (activePolls.has(issueId)) return;
	const intervalId = setInterval(() => {
		checkPrMergedByUrl(prUrl)
			.then((merged) => {
				if (merged) {
					stopMergePolling(issueId);
					kanbanEmitter.emit("issue:merged", issueId);
				}
			})
			.catch(() => {
				// ignore errors, keep polling
			});
	}, MERGE_POLL_INTERVAL_MS);
	activePolls.set(issueId, intervalId);
}

export interface KanbanStateData {
	cards: KanbanCard[];
	isEmpty: boolean;
	workComplete: { total: number; duration: number } | null;
	modelInUse: string | null;
}

class KanbanEmitter extends EventEmitter {}

export const kanbanEmitter = new KanbanEmitter();

export function registerBellListeners(bellEnabled: boolean): () => void {
	if (!bellEnabled) return () => {};

	const onDone = () => notify(1);
	const onReverted = () => notify(2);
	const onComplete = () => notify(1);

	kanbanEmitter.on("issue:done", onDone);
	kanbanEmitter.on("issue:reverted", onReverted);
	kanbanEmitter.on("work:complete", onComplete);

	return () => {
		kanbanEmitter.off("issue:done", onDone);
		kanbanEmitter.off("issue:reverted", onReverted);
		kanbanEmitter.off("work:complete", onComplete);
	};
}

export function useKanbanState(bellEnabled: boolean): KanbanStateData {
	const [cards, setCards] = useState<KanbanCard[]>([]);
	const [isEmpty, setIsEmpty] = useState(false);
	const [workComplete, setWorkComplete] = useState<{ total: number; duration: number } | null>(
		null,
	);
	const [modelInUse, setModelInUse] = useState<string | null>(null);

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
			if (prUrl) {
				startMergePolling(issueId, prUrl);
			}
		};

		const onMerged = (issueId: string) => {
			setCards((prev) => prev.map((c) => (c.id === issueId ? { ...c, merged: true } : c)));
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
		kanbanEmitter.on("issue:merged", onMerged);
		kanbanEmitter.on("issue:reverted", onReverted);
		kanbanEmitter.on("issue:skipped", onSkipped);
		kanbanEmitter.on("issue:killed", onKilled);
		kanbanEmitter.on("provider:paused", onProviderPaused);
		kanbanEmitter.on("provider:resumed", onProviderResumed);
		kanbanEmitter.on("issue:output", onOutput);

		const onModelChanged = (model: string) => setModelInUse(model);
		kanbanEmitter.on("provider:model-changed", onModelChanged);

		const onEmpty = () => setIsEmpty(true);
		const onComplete = (data: { total: number; duration: number }) => setWorkComplete(data);
		kanbanEmitter.on("work:empty", onEmpty);
		kanbanEmitter.on("work:complete", onComplete);

		const cleanupBell = registerBellListeners(bellEnabled);

		return () => {
			kanbanEmitter.off("issue:queued", onQueued);
			kanbanEmitter.off("issue:started", onStarted);
			kanbanEmitter.off("issue:done", onDone);
			kanbanEmitter.off("issue:merged", onMerged);
			kanbanEmitter.off("issue:reverted", onReverted);
			kanbanEmitter.off("issue:skipped", onSkipped);
			kanbanEmitter.off("issue:killed", onKilled);
			kanbanEmitter.off("provider:paused", onProviderPaused);
			kanbanEmitter.off("provider:resumed", onProviderResumed);
			kanbanEmitter.off("issue:output", onOutput);
			kanbanEmitter.off("provider:model-changed", onModelChanged);
			kanbanEmitter.off("work:empty", onEmpty);
			kanbanEmitter.off("work:complete", onComplete);
			cleanupBell();
			for (const issueId of activePolls.keys()) {
				stopMergePolling(issueId);
			}
		};
	}, [bellEnabled]);

	return { cards, isEmpty, workComplete, modelInUse };
}
