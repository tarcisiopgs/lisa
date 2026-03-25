import { Box, useApp, useInput } from "ink";
import { useEffect, useState } from "react";
import { resetTitle, startSpinner, stopSpinner } from "../output/terminal.js";
import type { LisaConfig, PlannedIssue } from "../types/index.js";
import { getCachedUpdateInfo, type UpdateInfo } from "../version.js";
import { Board } from "./board.js";
import { IssueDetail } from "./detail.js";
import { PlanChat } from "./plan-chat.js";
import { PlanDetail } from "./plan-detail.js";
import { PlanReview } from "./plan-review.js";
import { Sidebar, type SidebarMode } from "./sidebar.js";
import type { KanbanCard } from "./state.js";
import { kanbanEmitter, useKanbanState } from "./state.js";
import { useTerminalSize } from "./use-terminal-size.js";

type ActiveView = "board" | "detail" | "plan-chat" | "plan-review" | "plan-detail";

interface KanbanAppProps {
	config: LisaConfig;
	initialCards?: KanbanCard[];
}

export function KanbanApp({ config, initialCards = [] }: KanbanAppProps) {
	const { exit } = useApp();
	const { cards, isEmpty, isFetching, isWatching, isWatchPrompt, workComplete, modelInUse } =
		useKanbanState(config.bell ?? true, initialCards);
	const { rows } = useTerminalSize();

	const [activeView, setActiveView] = useState<ActiveView>("board");
	const [activeColIndex, setActiveColIndex] = useState(0);
	const [activeCardIndex, setActiveCardIndex] = useState(0);
	const [paused, setPaused] = useState(false);
	const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
	const [mergeConfirm, setMergeConfirm] = useState<string | null>(null);
	const [merging, setMerging] = useState<string | null>(null);
	const [updateInfo] = useState<UpdateInfo | null>(() => getCachedUpdateInfo());

	// Plan state
	const [planMessages, setPlanMessages] = useState<{ role: "user" | "ai"; content: string }[]>([]);
	const [planIssues, setPlanIssues] = useState<PlannedIssue[]>([]);
	const [planGoal, setPlanGoal] = useState("");
	const [planThinking, setPlanThinking] = useState(false);
	const [planSelectedIndex, setPlanSelectedIndex] = useState(0);

	// Set the initial model based on config
	useEffect(() => {
		const initialModel = config.provider_options?.[config.provider]?.models?.[0];
		if (!modelInUse && initialModel) {
			kanbanEmitter.emit("provider:model-changed", initialModel);
		}
	}, [modelInUse, config.provider, config.provider_options]);

	// Listen for clean-exit signal from the loop's SIGINT cleanup
	useEffect(() => {
		const onExit = () => exit();
		kanbanEmitter.on("tui:exit", onExit);
		return () => {
			kanbanEmitter.off("tui:exit", onExit);
		};
	}, [exit]);

	// Listen for plan events from outside the TUI
	useEffect(() => {
		const onAiMessage = (content: string) => {
			setPlanMessages((prev) => [...prev, { role: "ai", content }]);
			setPlanThinking(false);
		};
		const onThinking = () => setPlanThinking(true);
		const onIssuesReady = (issues: PlannedIssue[]) => {
			setPlanIssues(issues);
			setPlanSelectedIndex(0);
			setActiveView("plan-review");
			setPlanThinking(false);
		};

		const onEditResult = (index: number, updated: Partial<PlannedIssue> | null) => {
			if (!updated) return;
			setPlanIssues((prev) => {
				const next = [...prev];
				if (next[index]) {
					next[index] = { ...next[index], ...updated };
				}
				return next;
			});
		};

		const onDemoOpenPlan = (userMessage: string) => {
			setActiveView("plan-chat");
			setPlanMessages([{ role: "user", content: userMessage }]);
			setPlanGoal(userMessage);
			setPlanThinking(true);
		};
		const onDemoApprovePlan = () => {
			setActiveView("board");
		};

		kanbanEmitter.on("plan:ai-message", onAiMessage);
		kanbanEmitter.on("plan:thinking", onThinking);
		kanbanEmitter.on("plan:issues-ready", onIssuesReady);
		kanbanEmitter.on("plan:edit-result", onEditResult);
		kanbanEmitter.on("demo:open-plan", onDemoOpenPlan);
		kanbanEmitter.on("demo:approve-plan", onDemoApprovePlan);
		return () => {
			kanbanEmitter.off("plan:ai-message", onAiMessage);
			kanbanEmitter.off("plan:thinking", onThinking);
			kanbanEmitter.off("plan:issues-ready", onIssuesReady);
			kanbanEmitter.off("plan:edit-result", onEditResult);
			kanbanEmitter.off("demo:open-plan", onDemoOpenPlan);
			kanbanEmitter.off("demo:approve-plan", onDemoApprovePlan);
		};
	}, []);

	// Backlog: priority order (queueOrder), error cards sink to the bottom
	const backlog = [...cards.filter((c) => c.column === "backlog")].sort((a, b) => {
		if (a.hasError && !b.hasError) return 1;
		if (!a.hasError && b.hasError) return -1;
		return (a.queueOrder ?? 0) - (b.queueOrder ?? 0);
	});

	// In Progress: ordered by execution start time (earliest first)
	const inProgress = [...cards.filter((c) => c.column === "in_progress")].sort(
		(a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0),
	);
	const hasInProgress = inProgress.length > 0;

	// Animate the terminal tab title based on kanban state
	useEffect(() => {
		if (workComplete) {
			stopSpinner("Lisa \u2014 done \u2713");
		} else if (inProgress.length > 0) {
			const ids = inProgress.map((c) => c.id).join(", ");
			startSpinner(ids);
		} else {
			stopSpinner("Lisa \u266a");
		}
		return () => resetTitle();
	}, [inProgress, workComplete]);
	// Done: most recently finished on top, merged cards sink to the bottom
	const done = [...cards.filter((c) => c.column === "done")].sort((a, b) => {
		if (a.merged && !b.merged) return 1;
		if (!a.merged && b.merged) return -1;
		return (b.finishedAt ?? 0) - (a.finishedAt ?? 0);
	});
	const columnCards = [backlog, inProgress, done];

	// When the selected card changes column, sync the kanban cursor to its new position
	useEffect(() => {
		if (!selectedCardId || activeView !== "detail") return;
		const card = cards.find((c) => c.id === selectedCardId);
		if (!card) return;
		const colIndexMap: Record<"backlog" | "in_progress" | "done", number> = {
			backlog: 0,
			in_progress: 1,
			done: 2,
		};
		const newColIndex = colIndexMap[card.column];
		const colCards = cards.filter((c) => c.column === card.column);
		const newCardIndex = Math.max(
			0,
			colCards.findIndex((c) => c.id === selectedCardId),
		);
		setActiveColIndex(newColIndex);
		setActiveCardIndex(newCardIndex);
	}, [cards, selectedCardId, activeView]);

	const selectedCard =
		activeView === "detail" && selectedCardId
			? (cards.find((c) => c.id === selectedCardId) ?? null)
			: null;

	async function handleMergeRequest(card: KanbanCard) {
		const { checkPrCiStatus } = await import("../git/merge.js");
		const prUrl = card.prUrls[0]!;
		const ciStatus = await checkPrCiStatus(prUrl);
		if (ciStatus === "passing" || ciStatus === "unknown") {
			doMerge(card.id);
		} else {
			// CI not passing — show confirmation
			setMergeConfirm(card.id);
		}
	}

	async function doMerge(issueId: string) {
		const card = cards.find((c) => c.id === issueId);
		if (!card || card.prUrls.length === 0) return;
		setMerging(issueId);
		const { mergePr } = await import("../git/merge.js");
		let allSuccess = true;
		for (const prUrl of card.prUrls) {
			const result = await mergePr(prUrl);
			if (!result.success) {
				allSuccess = false;
				kanbanEmitter.emit("issue:output", issueId, `\nMerge failed: ${result.error}\n`);
			}
		}
		if (allSuccess) {
			kanbanEmitter.emit("issue:merged", issueId);
			// Post comment on issue via source (best-effort, non-blocking)
			kanbanEmitter.emit("issue:merge-comment", issueId, card.prUrls);
		}
		setMerging(null);
	}

	useInput((input, key) => {
		if (isWatchPrompt) {
			if (input === "w") {
				kanbanEmitter.emit("work:watch-prompt-resolved");
				kanbanEmitter.emit("loop:resume");
				return;
			}
			if (input === "q") {
				kanbanEmitter.emit("loop:quit");
				return;
			}
			return;
		}

		// Plan chat: ESC cancels, everything else handled by PlanChat component
		if (activeView === "plan-chat") {
			if (key.escape) {
				setActiveView("board");
			}
			return;
		}

		// Plan review: navigate, approve, edit, delete, detail, cancel
		if (activeView === "plan-review") {
			if (key.escape) {
				setActiveView("board");
				return;
			}
			if (key.upArrow) {
				setPlanSelectedIndex((prev) => Math.max(0, prev - 1));
				return;
			}
			if (key.downArrow) {
				setPlanSelectedIndex((prev) => Math.min(planIssues.length - 1, prev + 1));
				return;
			}
			if (key.return) {
				setActiveView("plan-detail");
				return;
			}
			if (input === "a") {
				kanbanEmitter.emit("plan:approved", planIssues, planGoal);
				setActiveView("board");
				return;
			}
			if (input === "d" && planIssues.length > 0) {
				const newIssues = [...planIssues];
				const removed = newIssues.splice(planSelectedIndex, 1)[0];
				// Update dependsOn references
				for (const issue of newIssues) {
					issue.dependsOn = issue.dependsOn.filter((d) => d !== removed?.order);
				}
				setPlanIssues(newIssues);
				if (newIssues.length === 0) {
					setActiveView("plan-chat");
				} else {
					setPlanSelectedIndex(Math.min(planSelectedIndex, Math.max(0, newIssues.length - 1)));
				}
				return;
			}
			if (input === "e") {
				kanbanEmitter.emit("plan:edit-issue", planSelectedIndex, planIssues[planSelectedIndex]);
				return;
			}
			return;
		}

		// Plan detail: ESC goes back to review, e opens editor
		if (activeView === "plan-detail") {
			if (key.escape) {
				setActiveView("plan-review");
				return;
			}
			if (input === "e") {
				kanbanEmitter.emit("plan:edit-issue", planSelectedIndex, planIssues[planSelectedIndex]);
				return;
			}
			return;
		}

		// Detail view: only legend-visible shortcuts (Esc, ↑↓, o, m) are handled.
		// Scroll and "o" are handled by IssueDetail's own useInput.
		if (activeView === "detail") {
			// Merge confirmation response
			if (mergeConfirm === selectedCardId) {
				if (input === "y") {
					setMergeConfirm(null);
					doMerge(selectedCardId!);
					return;
				}
				if (input === "n" || key.escape) {
					setMergeConfirm(null);
					return;
				}
				return; // Swallow all other input during confirmation
			}

			if (
				input === "m" &&
				selectedCard &&
				selectedCard.column === "done" &&
				!selectedCard.merged &&
				selectedCard.prUrls.length > 0 &&
				!merging
			) {
				handleMergeRequest(selectedCard);
				return;
			}

			if (key.escape) {
				setMergeConfirm(null);
				setActiveView("board");
				setSelectedCardId(null);
			}
			return;
		}

		// Board-only shortcuts below — all gated by activeView === "board"
		if (input === "m") {
			const card = columnCards[activeColIndex]?.[activeCardIndex];
			if (card && card.column === "done" && !card.merged && card.prUrls.length > 0 && !merging) {
				setSelectedCardId(card.id);
				setActiveView("detail");
				handleMergeRequest(card);
			}
			return;
		}

		if (input === "q") {
			// Emit SIGINT — the loop's cleanup will emit "tui:exit" to close Ink cleanly
			process.emit("SIGINT");
			return;
		}

		if (input === "p") {
			const next = !paused;
			setPaused(next);
			kanbanEmitter.emit(next ? "loop:pause" : "loop:resume");
			kanbanEmitter.emit(next ? "loop:pause-provider" : "loop:resume-provider");
			return;
		}

		if (input === "k" && hasInProgress) {
			// Target the selected card in the In Progress column, or the first one
			const targetCard = activeColIndex === 1 ? inProgress[activeCardIndex] : inProgress[0];
			kanbanEmitter.emit("loop:kill", targetCard?.id);
			if (!paused && inProgress.length <= 1) {
				setPaused(true);
				kanbanEmitter.emit("loop:pause");
			}
			return;
		}

		if (input === "s" && hasInProgress) {
			const targetCard = activeColIndex === 1 ? inProgress[activeCardIndex] : inProgress[0];
			kanbanEmitter.emit("loop:skip", targetCard?.id);
			if (paused && inProgress.length <= 1) {
				setPaused(false);
				kanbanEmitter.emit("loop:resume");
			}
			return;
		}

		if (input === "r" && isEmpty && backlog.length > 0) {
			kanbanEmitter.emit("loop:run");
			return;
		}

		if (input === "n") {
			setActiveView("plan-chat");
			setPlanMessages([]);
			setPlanIssues([]);
			setPlanGoal("");
			setPlanThinking(false);
			return;
		}

		// Number keys: jump directly to column (1=Backlog, 2=In Progress, 3=Done)
		if (input === "1" || input === "2" || input === "3") {
			const targetCol = Number(input) - 1;
			if (targetCol !== activeColIndex) {
				setActiveColIndex(targetCol);
				const colLen = columnCards[targetCol]?.length ?? 0;
				setActiveCardIndex(Math.min(activeCardIndex, Math.max(0, colLen - 1)));
			}
			return;
		}

		if (key.rightArrow) {
			const nextCol = (activeColIndex + 1) % 3;
			setActiveColIndex(nextCol);
			const colLen = columnCards[nextCol]?.length ?? 0;
			setActiveCardIndex(Math.min(activeCardIndex, Math.max(0, colLen - 1)));
			return;
		}

		if (key.leftArrow) {
			const prevCol = (activeColIndex + 2) % 3;
			setActiveColIndex(prevCol);
			const colLen = columnCards[prevCol]?.length ?? 0;
			setActiveCardIndex(Math.min(activeCardIndex, Math.max(0, colLen - 1)));
			return;
		}

		if (key.downArrow) {
			const colLen = columnCards[activeColIndex]?.length ?? 0;
			setActiveCardIndex((prev) => Math.min(prev + 1, Math.max(0, colLen - 1)));
			return;
		}

		if (key.upArrow) {
			setActiveCardIndex((prev) => Math.max(0, prev - 1));
			return;
		}

		if (key.return) {
			const card = columnCards[activeColIndex]?.[activeCardIndex];
			if (card) {
				setSelectedCardId(card.id);
				setActiveView("detail");
			}
		}
	});

	const labels = {
		backlog: config.source_config.pick_from,
		inProgress: config.source_config.in_progress,
		done: config.source_config.done,
	};

	const hasPrUrl = (selectedCard?.prUrls.length ?? 0) > 0;
	const canMerge =
		selectedCard?.column === "done" &&
		!selectedCard?.merged &&
		(selectedCard?.prUrls.length ?? 0) > 0;

	const providerOptions = config.provider_options?.[config.provider];
	const models = providerOptions?.models || (providerOptions?.model ? [providerOptions.model] : []);

	// Compute sidebar mode — reflects the actual context for legend rendering
	let sidebarMode: SidebarMode = "board";
	if (isWatchPrompt) sidebarMode = "watch-prompt";
	else if (isWatching) sidebarMode = "watching";
	else if (isFetching && activeView === "board") sidebarMode = "empty";
	else if (isEmpty && activeView === "board" && cards.length === 0) sidebarMode = "empty";
	else if (isEmpty && activeView === "board" && cards.length > 0) sidebarMode = "idle";
	else if (activeView === "plan-chat") sidebarMode = "plan-chat";
	else if (activeView === "plan-review" || activeView === "plan-detail")
		sidebarMode = "plan-review";
	else if (activeView === "detail") sidebarMode = "detail";
	else if (activeView === "board") sidebarMode = "board";

	return (
		<Box flexDirection="row" height={rows}>
			<Sidebar
				provider={config.provider}
				model={modelInUse}
				models={models}
				source={config.source}
				cwd={process.cwd()}
				activeView={sidebarMode}
				paused={paused}
				hasInProgress={hasInProgress}
				hasPrUrl={hasPrUrl}
				canMerge={canMerge}
				mergeConfirm={mergeConfirm}
				merging={merging}
				updateInfo={updateInfo}
				workComplete={workComplete}
				reviewers={config.pr?.reviewers}
				assignees={config.pr?.assignees}
			/>
			{activeView === "plan-chat" ? (
				<PlanChat
					messages={planMessages}
					isThinking={planThinking}
					onSend={(msg) => {
						setPlanMessages((prev) => [...prev, { role: "user", content: msg }]);
						if (!planGoal) setPlanGoal(msg);
						kanbanEmitter.emit("plan:user-message", msg);
					}}
					onCancel={() => setActiveView("board")}
				/>
			) : activeView === "plan-review" ? (
				<PlanReview
					goal={planGoal}
					issues={planIssues}
					selectedIndex={planSelectedIndex}
					onNavigate={setPlanSelectedIndex}
					onViewDetail={(idx) => {
						setPlanSelectedIndex(idx);
						setActiveView("plan-detail");
					}}
					onEdit={(idx) => kanbanEmitter.emit("plan:edit-issue", idx, planIssues[idx])}
					onDelete={(idx) => {
						const newIssues = [...planIssues];
						newIssues.splice(idx, 1);
						setPlanIssues(newIssues);
						if (newIssues.length === 0) {
							setActiveView("plan-chat");
						} else {
							setPlanSelectedIndex(Math.min(idx, Math.max(0, newIssues.length - 1)));
						}
					}}
					onApprove={() => {
						kanbanEmitter.emit("plan:approved", planIssues, planGoal);
						setActiveView("board");
					}}
					onCancel={() => setActiveView("board")}
				/>
			) : activeView === "plan-detail" && planIssues[planSelectedIndex] ? (
				<PlanDetail
					issue={planIssues[planSelectedIndex]}
					onBack={() => setActiveView("plan-review")}
					onEdit={() =>
						kanbanEmitter.emit("plan:edit-issue", planSelectedIndex, planIssues[planSelectedIndex])
					}
				/>
			) : activeView === "board" || !selectedCard ? (
				<Board
					cards={cards}
					columns={{ backlog, inProgress, done }}
					labels={labels}
					isEmpty={isEmpty}
					isFetching={isFetching}
					isWatching={isWatching}
					isWatchPrompt={isWatchPrompt}
					workComplete={workComplete}
					activeColIndex={activeColIndex}
					activeCardIndex={activeCardIndex}
					paused={paused}
				/>
			) : (
				<IssueDetail
					card={selectedCard}
					onBack={() => {
						setActiveView("board");
						setSelectedCardId(null);
					}}
					reviewers={config.pr?.reviewers}
					assignees={config.pr?.assignees}
				/>
			)}
		</Box>
	);
}
