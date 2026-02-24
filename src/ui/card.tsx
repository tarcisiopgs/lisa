import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { useEffect, useState } from "react";
import type { KanbanCard } from "./state.js";

function formatElapsed(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	if (minutes > 0) return `${minutes}m ${remainingSeconds}s`;
	return `${seconds}s`;
}

export function Card({ card }: { card: KanbanCard }) {
	const [now, setNow] = useState(Date.now());

	useEffect(() => {
		if (card.column !== "in_progress") return;
		const interval = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(interval);
	}, [card.column]);

	const truncated = card.title.length > 22 ? `${card.title.slice(0, 19)}...` : card.title;
	const borderColor = card.hasError ? "red" : card.column === "done" ? "green" : "white";

	return (
		<Box
			borderStyle="round"
			borderColor={borderColor}
			flexDirection="column"
			paddingX={1}
			marginBottom={1}
		>
			<Text bold color="cyan">
				{card.id}
			</Text>
			<Text>{truncated}</Text>
			{card.column === "in_progress" && card.startedAt !== undefined && (
				<Box>
					<Text color="yellow">
						<Spinner type="dots" />
					</Text>
					<Text color="yellow"> {formatElapsed(now - card.startedAt)}</Text>
				</Box>
			)}
		</Box>
	);
}
