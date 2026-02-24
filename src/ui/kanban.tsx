import { Box, useApp, useInput } from "ink";
import { useState } from "react";
import type { LisaConfig } from "../types/index.js";
import { Board } from "./board.js";
import { IssueDetail } from "./detail.js";
import { Sidebar } from "./sidebar.js";
import { useKanbanState } from "./state.js";

interface KanbanAppProps {
	config: LisaConfig;
}

export function KanbanApp({ config }: KanbanAppProps) {
	const { exit } = useApp();
	const { cards, isEmpty, workComplete } = useKanbanState();

	const [activeView, setActiveView] = useState<"board" | "detail">("board");
	const [activeColIndex, setActiveColIndex] = useState(0);
	const [activeCardIndex, setActiveCardIndex] = useState(0);

	const backlog = cards.filter((c) => c.column === "backlog");
	const inProgress = cards.filter((c) => c.column === "in_progress");
	const done = cards.filter((c) => c.column === "done");
	const columnCards = [backlog, inProgress, done];

	useInput((input, key) => {
		if (activeView === "detail") {
			if (key.escape) setActiveView("board");
			return;
		}

		if (input === "q") {
			process.emit("SIGINT");
			exit();
			return;
		}

		if (key.tab && !key.shift) {
			const nextCol = (activeColIndex + 1) % 3;
			setActiveColIndex(nextCol);
			const colLen = columnCards[nextCol]?.length ?? 0;
			setActiveCardIndex(Math.min(activeCardIndex, Math.max(0, colLen - 1)));
			return;
		}

		if (key.tab && key.shift) {
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
			const colLen = columnCards[activeColIndex]?.length ?? 0;
			if (colLen > 0) setActiveView("detail");
		}
	});

	const labels = {
		backlog: config.source_config.pick_from,
		inProgress: config.source_config.in_progress,
		done: config.source_config.done,
	};

	const selectedCard =
		activeView === "detail" ? (columnCards[activeColIndex]?.[activeCardIndex] ?? null) : null;

	return (
		<Box flexDirection="row" height={process.stdout.rows}>
			<Sidebar provider={config.provider} source={config.source} cwd={process.cwd()} />
			{activeView === "board" || !selectedCard ? (
				<Board
					cards={cards}
					labels={labels}
					isEmpty={isEmpty}
					workComplete={workComplete}
					activeColIndex={activeColIndex}
					activeCardIndex={activeCardIndex}
				/>
			) : (
				<IssueDetail card={selectedCard} onBack={() => setActiveView("board")} />
			)}
		</Box>
	);
}
