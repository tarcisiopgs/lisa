import { Box, Text } from "ink";
import { Card } from "./card.js";
import type { KanbanCard } from "./state.js";

interface ColumnProps {
	label: string;
	cards: KanbanCard[];
}

export function Column({ label, cards }: ColumnProps) {
	return (
		<Box flexDirection="column" flexGrow={1} borderStyle="single" paddingX={1}>
			<Text bold color="cyan">
				{label} ({cards.length})
			</Text>
			<Box height={1} />
			{cards.map((card) => (
				<Card key={card.id} card={card} />
			))}
		</Box>
	);
}
