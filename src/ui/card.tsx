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

export function Card({ card, isSelected = false }: { card: KanbanCard; isSelected?: boolean }) {
	const [now, setNow] = useState(Date.now());

	useEffect(() => {
		if (card.column !== "in_progress") return;
		const interval = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(interval);
	}, [card.column]);

	// Determine status indicator and color
	let statusGlyph: string;
	let statusColor: string;

	if (card.hasError) {
		statusGlyph = "✖";
		statusColor = "red";
	} else if (card.column === "in_progress") {
		statusGlyph = "◉";
		statusColor = "yellow";
	} else if (card.column === "done") {
		statusGlyph = "✔";
		statusColor = "green";
	} else {
		statusGlyph = "○";
		statusColor = "white";
	}

	// Selection highlight: left bar
	const selectionBar = isSelected ? "▐" : " ";
	const selectionColor = isSelected ? "yellow" : "white";

	const truncated = card.title.length > 30 ? `${card.title.slice(0, 27)}…` : card.title;

	return (
		<Box
			flexDirection="row"
			paddingX={0}
			marginBottom={0}
			borderStyle="single"
			borderColor={card.hasError ? "red" : isSelected ? "yellow" : "gray"}
		>
			{/* Selection bar */}
			<Text color={selectionColor}>{selectionBar}</Text>

			{/* Main content */}
			<Box flexDirection="column" flexGrow={1} paddingX={1}>
				{/* Top row: ID + status glyph */}
				<Box flexDirection="row" justifyContent="space-between">
					<Text color="yellow" bold={isSelected}>
						{card.id}
					</Text>
					<Text color={statusColor}>{statusGlyph}</Text>
				</Box>

				{/* Title row */}
				<Text bold={isSelected} dimColor={!isSelected}>
					{truncated}
				</Text>

				{/* Timer row (only when relevant) */}
				{card.column === "in_progress" && card.startedAt !== undefined && (
					<Box flexDirection="row" marginTop={0}>
						<Text color="yellow">
							<Spinner type="dots" />
						</Text>
						<Text color="yellow"> {formatElapsed(now - card.startedAt)}</Text>
					</Box>
				)}
				{card.column === "done" &&
					card.startedAt !== undefined &&
					card.finishedAt !== undefined && (
						<Text color="green">
							{"✔ "}
							{formatElapsed(card.finishedAt - card.startedAt)}
						</Text>
					)}
				{card.hasError && <Text color="red">FAILED</Text>}
			</Box>
		</Box>
	);
}
