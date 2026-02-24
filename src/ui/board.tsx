import { Box } from "ink";
import { Column } from "./column.js";
import type { KanbanCard } from "./state.js";

interface BoardProps {
	cards: KanbanCard[];
	labels: {
		backlog: string;
		inProgress: string;
		done: string;
	};
}

export function Board({ cards, labels }: BoardProps) {
	const backlog = cards.filter((c) => c.column === "backlog");
	const inProgress = cards.filter((c) => c.column === "in_progress");
	const done = cards.filter((c) => c.column === "done");

	return (
		<Box flexGrow={1} flexDirection="row">
			<Column label={labels.backlog} cards={backlog} />
			<Column label={labels.inProgress} cards={inProgress} />
			<Column label={labels.done} cards={done} />
		</Box>
	);
}
