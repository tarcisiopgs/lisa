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

// Wraps a title into at most two lines of `maxWidth` chars each.
// Prefers word boundaries; falls back to hard-cutting if a single word exceeds maxWidth.
function wrapTitle(title: string, maxWidth: number): [string, string] {
	if (title.length <= maxWidth) return [title, ""];

	const words = title.split(" ");
	let line1 = "";
	let i = 0;

	for (; i < words.length; i++) {
		const word = words[i] ?? "";
		const candidate = line1 ? `${line1} ${word}` : word;
		if (candidate.length > maxWidth) break;
		line1 = candidate;
	}

	// If no word fit (single very long word), hard-cut
	if (!line1) {
		line1 = title.slice(0, maxWidth);
		const rest = title.slice(maxWidth);
		const line2 = rest.length > maxWidth ? `${rest.slice(0, maxWidth - 1)}…` : rest;
		return [line1, line2];
	}

	const remaining = words.slice(i).join(" ");
	const line2 = remaining.length > maxWidth ? `${remaining.slice(0, maxWidth - 1)}…` : remaining;
	return [line1, line2];
}

export function Card({
	card,
	isSelected = false,
	paused = false,
}: { card: KanbanCard; isSelected?: boolean; paused?: boolean }) {
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

	// CARD_TITLE_WIDTH must stay in sync with CARD_INNER_WIDTH in column.tsx.
	// Derivation: column border (2) + column paddingX (2) + card border (2) +
	// selection bar (1) + card paddingX (2) + status glyph + space (2) = 11 overhead
	// subtracted from terminal width / 3. Using a safe fixed width of 28 chars keeps
	// titles readable at any terminal width >= ~100 cols.
	const CARD_TITLE_WIDTH = 28;
	const [titleLine1, titleLine2] = wrapTitle(card.title, CARD_TITLE_WIDTH);

	const isPausedInProgress = paused && card.column === "in_progress";

	return (
		<Box
			flexDirection="row"
			paddingX={0}
			marginBottom={0}
			borderStyle="single"
			borderColor={card.hasError ? "red" : isPausedInProgress ? "gray" : isSelected ? "yellow" : "gray"}
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

				{/* Title: always two rows to keep card height stable */}
				<Text bold={isSelected} dimColor={!isSelected}>
					{titleLine1}
				</Text>
				<Text bold={isSelected} dimColor={!isSelected}>
					{titleLine2}
				</Text>

				{/* Timer / completion / error row */}
				{card.column === "in_progress" && card.startedAt !== undefined && (
					<Box flexDirection="row" marginTop={0}>
						{isPausedInProgress ? (
							<Text color="gray">{"⏸"}</Text>
						) : (
							<Text color="yellow">
								<Spinner type="dots" />
							</Text>
						)}
						<Text color={isPausedInProgress ? "gray" : "yellow"} dimColor={isPausedInProgress}>
							{" "}
							{formatElapsed(now - card.startedAt)}
						</Text>
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
