import { Box, Text } from "ink";
import { useMemo } from "react";
import { Column } from "./column.js";
import { formatElapsed } from "./format.js";
import type { KanbanCard } from "./state.js";

interface BoardProps {
	cards: KanbanCard[];
	labels: {
		backlog: string;
		inProgress: string;
		done: string;
	};
	isEmpty: boolean;
	isWatching?: boolean;
	isWatchPrompt?: boolean;
	workComplete: { total: number; duration: number } | null;
	activeColIndex?: number;
	activeCardIndex?: number;
	paused?: boolean;
}

export function Board({
	cards,
	labels,
	isEmpty,
	isWatching = false,
	isWatchPrompt = false,
	workComplete,
	activeColIndex = 0,
	activeCardIndex = 0,
	paused = false,
}: BoardProps) {
	const backlog = useMemo(() => cards.filter((c) => c.column === "backlog"), [cards]);
	const inProgress = useMemo(() => cards.filter((c) => c.column === "in_progress"), [cards]);
	const done = useMemo(() => cards.filter((c) => c.column === "done"), [cards]);

	if (isWatching) {
		return (
			<Box flexGrow={1} alignItems="center" justifyContent="center">
				<Box
					flexDirection="column"
					borderStyle="single"
					borderColor="cyan"
					paddingX={3}
					paddingY={1}
				>
					<Text color="cyan" bold>
						{"◎  WATCHING FOR ISSUES..."}
					</Text>
					<Box height={1} />
					<Text color="white" dimColor>
						Polling every 60s for new issues with the ready label.
					</Text>
					<Box height={1} />
					<Text color="gray" dimColor>
						Press [q] to quit
					</Text>
				</Box>
			</Box>
		);
	}

	if (isWatchPrompt) {
		return (
			<Box flexGrow={1} alignItems="center" justifyContent="center">
				<Box
					flexDirection="column"
					borderStyle="single"
					borderColor="green"
					paddingX={3}
					paddingY={1}
				>
					{workComplete && (
						<>
							<Text color="green" bold>
								{`◈  ${workComplete.total} issue${workComplete.total !== 1 ? "s" : ""} resolved`}
							</Text>
							<Box height={1} />
						</>
					)}
					<Text color="cyan" bold>
						{"◎  CONTINUE WATCHING?"}
					</Text>
					<Box height={1} />
					<Text color="white" dimColor>
						All issues have been processed.
					</Text>
					<Box height={1} />
					<Text color="gray" dimColor>
						[
						<Text color="cyan" bold>
							w
						</Text>
						] Watch / [
						<Text color="cyan" bold>
							q
						</Text>
						] Quit
					</Text>
				</Box>
			</Box>
		);
	}

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
						Press [n] to plan and create new issues
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
						{formatElapsed(workComplete.duration)}
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
