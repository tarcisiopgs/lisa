import { Box, Text } from "ink";
import { Column } from "./column.js";
import type { KanbanCard } from "./state.js";

function formatDuration(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

interface BoardProps {
	cards: KanbanCard[];
	labels: {
		backlog: string;
		inProgress: string;
		done: string;
	};
	isEmpty: boolean;
	workComplete: { total: number; duration: number } | null;
	activeColIndex?: number;
	activeCardIndex?: number;
	paused?: boolean;
}

export function Board({
	cards,
	labels,
	isEmpty,
	workComplete,
	activeColIndex = 0,
	activeCardIndex = 0,
	paused = false,
}: BoardProps) {
	const backlog = cards.filter((c) => c.column === "backlog");
	const inProgress = cards.filter((c) => c.column === "in_progress");
	const done = cards.filter((c) => c.column === "done");

	if (isEmpty) {
		return (
			<Box flexGrow={1} alignItems="center" justifyContent="center">
				<Box
					flexDirection="column"
					borderStyle="single"
					borderColor="yellow"
					paddingX={3}
					paddingY={1}
				>
					<Text color="yellow" bold>
						{"◈  QUEUE EMPTY"}
					</Text>
					<Box height={1} />
					<Text color="white" dimColor>
						No issues match the current filters.
					</Text>
					<Box height={1} />
					<Text color="gray" dimColor>
						Check source config · labels · status
					</Text>
				</Box>
			</Box>
		);
	}

	return (
		<Box flexGrow={1} flexDirection="column">
			{/* Completion banner */}
			{workComplete && (
				<Box borderStyle="single" borderColor="green" paddingX={2} paddingY={0} marginBottom={0}>
					<Text color="green" bold>
						{"◈ "}
					</Text>
					<Text color="white" bold>
						{workComplete.total}
					</Text>
					<Text color="white">{` issue${workComplete.total !== 1 ? "s" : ""} resolved`}</Text>
					<Text color="green">{" · "}</Text>
					<Text color="green" bold>
						{formatDuration(workComplete.duration)}
					</Text>
				</Box>
			)}

			{/* Columns */}
			<Box flexGrow={1} flexDirection="row">
				<Column
					label={labels.backlog}
					cards={backlog}
					isFocused={activeColIndex === 0}
					activeCardIndex={activeColIndex === 0 ? activeCardIndex : 0}
					paused={paused}
				/>
				<Column
					label={labels.inProgress}
					cards={inProgress}
					isFocused={activeColIndex === 1}
					activeCardIndex={activeColIndex === 1 ? activeCardIndex : 0}
					paused={paused}
				/>
				<Column
					label={labels.done}
					cards={done}
					isFocused={activeColIndex === 2}
					activeCardIndex={activeColIndex === 2 ? activeCardIndex : 0}
					paused={paused}
				/>
			</Box>
		</Box>
	);
}
