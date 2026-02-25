import { Box, Text } from "ink";
import { Card } from "./card.js";
import type { KanbanCard } from "./state.js";

interface ColumnProps {
	label: string;
	cards: KanbanCard[];
	isFocused?: boolean;
	activeCardIndex?: number;
	paused?: boolean;
}

// Each card: border (2) + ID row (1) + title line 1 (1) + title line 2 (1) + status row (1) = 6 rows total
const CARD_HEIGHT = 6;
const HEADER_ROWS = 4; // column header band + spacing

export function Column({ label, cards, isFocused = false, activeCardIndex = 0, paused = false }: ColumnProps) {
	const terminalRows = process.stdout.rows ?? 24;
	const visibleCount = Math.max(1, Math.floor((terminalRows - HEADER_ROWS) / CARD_HEIGHT));

	let scrollOffset = 0;
	if (activeCardIndex >= visibleCount) {
		scrollOffset = activeCardIndex - visibleCount + 1;
	}
	scrollOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, cards.length - visibleCount)));

	const visibleCards = cards.slice(scrollOffset, scrollOffset + visibleCount);
	const hiddenAbove = scrollOffset;
	const hiddenBelow = Math.max(0, cards.length - scrollOffset - visibleCount);

	const borderColor = isFocused ? "yellow" : "gray";
	const headerColor = isFocused ? "yellow" : "white";

	// Status summary counts for the header
	const runningCount = cards.filter((c) => c.column === "in_progress").length;
	const errorCount = cards.filter((c) => c.hasError).length;

	return (
		<Box
			flexDirection="column"
			flexGrow={1}
			flexBasis={0}
			borderStyle="single"
			borderColor={borderColor}
			paddingX={1}
			paddingY={0}
		>
			{/* Column header band */}
			<Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
				<Box flexDirection="row">
					{isFocused && (
						<Text color="yellow" bold>
							{"▶ "}
						</Text>
					)}
					{!isFocused && <Text color="gray">{"  "}</Text>}
					<Text color={headerColor} bold>
						{label.toUpperCase()}
					</Text>
				</Box>
				<Box flexDirection="row">
					{errorCount > 0 && <Text color="red" bold>{`!${errorCount} `}</Text>}
					{runningCount > 0 && <Text color="yellow">{`~${runningCount} `}</Text>}
					<Text color={headerColor}>{`[${cards.length}]`}</Text>
				</Box>
			</Box>

			{/* Scroll hint above */}
			{hiddenAbove > 0 && (
				<Box justifyContent="center">
					<Text color="yellow" dimColor>{`↑ ${hiddenAbove} more`}</Text>
				</Box>
			)}

			{/* Cards */}
			{visibleCards.map((card, idx) => {
				const absoluteIdx = scrollOffset + idx;
				const isSelected = isFocused && absoluteIdx === activeCardIndex;
				return <Card key={card.id} card={card} isSelected={isSelected} paused={paused} />;
			})}

			{/* Empty state */}
			{cards.length === 0 && (
				<Box justifyContent="center" paddingY={1}>
					<Text color="gray" dimColor>
						— empty —
					</Text>
				</Box>
			)}

			{/* Scroll hint below */}
			{hiddenBelow > 0 && (
				<Box justifyContent="center">
					<Text color="yellow" dimColor>{`↓ ${hiddenBelow} more`}</Text>
				</Box>
			)}
		</Box>
	);
}
