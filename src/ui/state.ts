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
	prUrls: string[];
	hasError?: boolean;
	outputLog: string;
	logFile?: string;
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

function stopMergePolling(key: string): void {
	const interval = activePolls.get(key);
	if (interval !== undefined) {
		clearInterval(interval);
		activePolls.delete(key);
	}
}

function startMergePolling(issueId: string, prUrl: string): void {
	if (activePolls.has(prUrl)) return;
	const intervalId = setInterval(() => {
		checkPrMergedByUrl(prUrl)
			.then((merged) => {
				if (merged) {
					stopMergePolling(prUrl);
					kanbanEmitter.emit("issue:merged", issueId);
				}
			})
			.catch(() => {
				// ignore errors, keep polling
			});
	}, MERGE_POLL_INTERVAL_MS);
	activePolls.set(prUrl, intervalId);
}

export interface KanbanStateData {
	cards: KanbanCard[];
	isEmpty: boolean;
	isWatching: boolean;
	isWatchPrompt: boolean;
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

export function useKanbanState(
	bellEnabled: boolean,
	initialCards: KanbanCard[] = [],
): KanbanStateData {
	const [cards, setCards] = useState<KanbanCard[]>(initialCards);
	const [isEmpty, setIsEmpty] = useState(false);
	const [isWatching, setIsWatching] = useState(false);
	const [isWatchPrompt, setIsWatchPrompt] = useState(false);
	const [workComplete, setWorkComplete] = useState<{ total: number; duration: number } | null>(
		null,
	);
	const [modelInUse, setModelInUse] = useState<string | null>(null);

	useEffect(() => {
		const onQueued = (issue: Issue) => {
			setCards((prev) => {
				if (prev.some((c) => c.id === issue.id)) return prev;
				return [
					...prev,
					{ id: issue.id, title: issue.title, column: "backlog", prUrls: [], outputLog: "" },
				];
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
								prUrls: [],
								pausedAt: undefined,
								pauseAccumulated: 0,
							}
						: c,
				),
			);
		};

		const onDone = (issueId: string, prUrls: string[]) => {
			setCards((prev) =>
				prev.map((c) =>
					c.id === issueId ? { ...c, column: "done" as const, prUrls, finishedAt: Date.now() } : c,
				),
			);
			for (const url of prUrls) {
				startMergePolling(issueId, url);
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

		const onLogFile = (issueId: string, logFile: string) => {
			setCards((prev) => prev.map((c) => (c.id === issueId ? { ...c, logFile } : c)));
		};

		const MAX_OUTPUT_SIZE = 200_000; // ~200 KB cap per issue
		const onOutput = (issueId: string, text: string) => {
			setCards((prev) =>
				prev.map((c) => {
					if (c.id !== issueId) return c;
					let newLog = c.outputLog + text;
					if (newLog.length > MAX_OUTPUT_SIZE) {
						// Trim from the front, preserving line boundaries
						const trimAt = newLog.indexOf("\n", newLog.length - MAX_OUTPUT_SIZE);
						newLog = trimAt !== -1 ? newLog.slice(trimAt + 1) : newLog.slice(-MAX_OUTPUT_SIZE);
					}
					return { ...c, outputLog: newLog };
				}),
			);
		};

		const onReconcileRemove = (issueId: string) => {
			setCards((prev) => prev.filter((c) => c.id !== issueId));
		};

		kanbanEmitter.on("issue:queued", onQueued);
		kanbanEmitter.on("issue:started", onStarted);
		kanbanEmitter.on("issue:done", onDone);
		kanbanEmitter.on("issue:merged", onMerged);
		kanbanEmitter.on("issue:reverted", onReverted);
		kanbanEmitter.on("issue:skipped", onSkipped);
		kanbanEmitter.on("issue:killed", onKilled);
		kanbanEmitter.on("issue:reconcile-remove", onReconcileRemove);
		kanbanEmitter.on("provider:paused", onProviderPaused);
		kanbanEmitter.on("provider:resumed", onProviderResumed);
		kanbanEmitter.on("issue:log-file", onLogFile);
		kanbanEmitter.on("issue:output", onOutput);

		const onModelChanged = (model: string) => setModelInUse(model);
		kanbanEmitter.on("provider:model-changed", onModelChanged);

		const onEmpty = () => setIsEmpty(true);
		const onComplete = (data: { total: number; duration: number }) => setWorkComplete(data);
		const onWatching = () => setIsWatching(true);
		const onWatchResume = () => setIsWatching(false);
		const onWatchPrompt = () => {
			setIsWatchPrompt(true);
			setIsWatching(false);
		};
		const onWatchPromptResolved = () => setIsWatchPrompt(false);
		kanbanEmitter.on("work:empty", onEmpty);
		kanbanEmitter.on("work:complete", onComplete);
		kanbanEmitter.on("work:watching", onWatching);
		kanbanEmitter.on("work:watch-resume", onWatchResume);
		kanbanEmitter.on("work:watch-prompt", onWatchPrompt);
		kanbanEmitter.on("work:watch-prompt-resolved", onWatchPromptResolved);

		const cleanupBell = registerBellListeners(bellEnabled);

		return () => {
			kanbanEmitter.off("issue:queued", onQueued);
			kanbanEmitter.off("issue:started", onStarted);
			kanbanEmitter.off("issue:done", onDone);
			kanbanEmitter.off("issue:merged", onMerged);
			kanbanEmitter.off("issue:reverted", onReverted);
			kanbanEmitter.off("issue:skipped", onSkipped);
			kanbanEmitter.off("issue:killed", onKilled);
			kanbanEmitter.off("issue:reconcile-remove", onReconcileRemove);
			kanbanEmitter.off("provider:paused", onProviderPaused);
			kanbanEmitter.off("provider:resumed", onProviderResumed);
			kanbanEmitter.off("issue:log-file", onLogFile);
			kanbanEmitter.off("issue:output", onOutput);
			kanbanEmitter.off("provider:model-changed", onModelChanged);
			kanbanEmitter.off("work:empty", onEmpty);
			kanbanEmitter.off("work:complete", onComplete);
			kanbanEmitter.off("work:watching", onWatching);
			kanbanEmitter.off("work:watch-resume", onWatchResume);
			kanbanEmitter.off("work:watch-prompt", onWatchPrompt);
			kanbanEmitter.off("work:watch-prompt-resolved", onWatchPromptResolved);
			cleanupBell();
			for (const issueId of activePolls.keys()) {
				stopMergePolling(issueId);
			}
		};
	}, [bellEnabled]);

	// Restart merge polling for Done cards hydrated from persisted state
	// biome-ignore lint/correctness/useExhaustiveDependencies: initialCards is stable (from useState seed) — only run on mount
	useEffect(() => {
		for (const card of initialCards) {
			if (card.column === "done" && card.prUrls.length > 0 && !card.merged) {
				for (const url of card.prUrls) {
					startMergePolling(card.id, url);
				}
			}
		}
	}, []);

	return { cards, isEmpty, isWatching, isWatchPrompt, workComplete, modelInUse };
}
