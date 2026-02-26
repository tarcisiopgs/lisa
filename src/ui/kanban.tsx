import { Box, useApp, useInput } from "ink";
import { useEffect, useState } from "react";
import { resetTitle, startSpinner, stopSpinner } from "../output/terminal.js";
import type { LisaConfig } from "../types/index.js";
import { Board } from "./board.js";
import { IssueDetail } from "./detail.js";
import { Sidebar } from "./sidebar.js";
import { kanbanEmitter, useKanbanState } from "./state.js";
import { useTerminalSize } from "./use-terminal-size.js";

interface KanbanAppProps {
	config: LisaConfig;
}

export function KanbanApp({ config }: KanbanAppProps) {
	const { exit } = useApp();
	const { cards, isEmpty, workComplete, modelInUse } = useKanbanState(config.bell ?? true);
	const { rows } = useTerminalSize();

	const [activeView, setActiveView] = useState<"board" | "detail">("board");
	const [activeColIndex, setActiveColIndex] = useState(0);
	const [activeCardIndex, setActiveCardIndex] = useState(0);
	const [paused, setPaused] = useState(false);
	const [selectedCardId, setSelectedCardId] = useState<string | null>(null);

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

	const backlog = cards.filter((c) => c.column === "backlog");
	const inProgress = cards.filter((c) => c.column === "in_progress");
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
	const done = cards.filter((c) => c.column === "done");
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

	useInput((input, key) => {
		if (input === "q") {
			// Emit SIGINT — the loop's cleanup will emit "tui:exit" to close Ink cleanly
			process.emit("SIGINT");
			return;
		}

		if (activeView === "detail") {
			if (key.escape) {
				setActiveView("board");
				setSelectedCardId(null);
			}
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

	const selectedCard =
		activeView === "detail" && selectedCardId
			? (cards.find((c) => c.id === selectedCardId) ?? null)
			: null;

	const hasPrUrl = selectedCard?.prUrl !== undefined && selectedCard.prUrl.length > 0;

	const providerOptions = config.provider_options?.[config.provider];
	const models = providerOptions?.models || (providerOptions?.model ? [providerOptions.model] : []);

	return (
		<Box flexDirection="row" height={rows}>
			<Sidebar
				provider={config.provider}
				model={modelInUse}
				models={models}
				source={config.source}
				cwd={process.cwd()}
				activeView={activeView}
				paused={paused}
				hasInProgress={hasInProgress}
				hasPrUrl={hasPrUrl}
			/>
			{activeView === "board" || !selectedCard ? (
				<Board
					cards={cards}
					labels={labels}
					isEmpty={isEmpty}
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
				/>
			)}
		</Box>
	);
}
