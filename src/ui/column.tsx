import { Box, Text } from "ink";
import { Card } from "./card.js";
import type { KanbanCard } from "./state.js";

interface ColumnProps {
	label: string;
	cards: KanbanCard[];
	isFocused?: boolean;
	activeCardIndex?: number;
}

const CARD_HEIGHT = 5;
const HEADER_ROWS = 3;

export function Column({ label, cards, isFocused = false, activeCardIndex = 0 }: ColumnProps) {
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

	const borderColor = isFocused ? "cyan" : undefined;

	return (
		<Box
			flexDirection="column"
			flexGrow={1}
			borderStyle="single"
			borderColor={borderColor}
			paddingX={1}
		>
			<Text bold color="cyan">
				{label} ({cards.length})
			</Text>
			<Box height={1} />
			{hiddenAbove > 0 && (
				<Text dimColor>
					{"↑"} {hiddenAbove} more
				</Text>
			)}
			{visibleCards.map((card, idx) => {
				const absoluteIdx = scrollOffset + idx;
				const isSelected = isFocused && absoluteIdx === activeCardIndex;
				return <Card key={card.id} card={card} isSelected={isSelected} />;
			})}
			{hiddenBelow > 0 && (
				<Text dimColor>
					{"↓"} {hiddenBelow} more
				</Text>
			)}
		</Box>
	);
}
