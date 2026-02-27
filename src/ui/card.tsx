import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { useEffect, useState } from "react";
import type { KanbanCard } from "./state.js";

// Wide character regex: covers CJK, Hangul, full-width, and astral-plane emoji.
// These characters occupy 2 terminal columns but JS counts them as 1 codepoint,
// which would make padEnd() produce strings that are too short for the border.
const WIDE_CHAR_RE =
	/[\u1100-\u115F\u2E80-\u303E\u3041-\u33BF\u3400-\u4DBF\u4E00-\uA4CF\uAC00-\uD7FF\uF900-\uFAFF\uFE10-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]|[\u{1F000}-\u{1FFFF}]|[\u{20000}-\u{2FA20}]/gu;

/**
 * Replace double-width characters (CJK, Hangul, full-width, emoji) with a single-width
 * placeholder ("?") so that String.padEnd() counts terminal columns correctly.
 */
export function stripDoubleWidth(str: string): string {
	return str.replace(WIDE_CHAR_RE, "?");
}

export function formatElapsed(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	if (minutes > 0) return `${minutes}m ${remainingSeconds}s`;
	return `${seconds}s`;
}

// Wraps a title into at most two lines of `maxWidth` chars each.
// Prefers word boundaries; falls back to hard-cutting if a single word exceeds maxWidth.
export function wrapTitle(title: string, maxWidth: number): [string, string] {
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

// Strip ANSI escape codes and extract the last non-empty line from provider output.
export function getLastOutputLine(outputLog: string, maxWidth: number): string {
	if (!outputLog) return "";

	// Strip ANSI escape codes (CSI sequences and OSC sequences)
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI escape stripping
	const ansiPattern = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\].*?(?:\x07|\x1B\\))/g;
	const stripped = outputLog.replace(ansiPattern, "");

	// Split by newlines, handle carriage returns within lines
	const lines = stripped
		.split(/\r?\n/)
		.map((line) => {
			const parts = line.split("\r");
			return (parts[parts.length - 1] ?? "").trim();
		})
		.filter((line) => line.length > 0);

	if (lines.length === 0) return "";

	const lastLine = lines[lines.length - 1] ?? "";

	if (lastLine.length > maxWidth) {
		return `${lastLine.slice(0, maxWidth - 1)}…`;
	}

	return lastLine;
}

export function Card({
	card,
	isSelected = false,
	paused = false,
	cardWidth = 28,
}: {
	card: KanbanCard;
	isSelected?: boolean;
	paused?: boolean;
	/** Width (in terminal columns) available for card content. Passed from Column. */
	cardWidth?: number;
}) {
	const [now, setNow] = useState(Date.now());

	const isPausedInProgress = paused && card.column === "in_progress";

	useEffect(() => {
		if (card.column !== "in_progress" || isPausedInProgress) return;
		const interval = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(interval);
	}, [card.column, isPausedInProgress]);

	// Determine status indicator and color
	let statusGlyph: string;
	let statusColor: string;

	if (card.killed) {
		statusGlyph = "✖";
		statusColor = "red";
	} else if (card.skipped) {
		statusGlyph = "⏭";
		statusColor = "gray";
	} else if (card.hasError) {
		statusGlyph = "✖";
		statusColor = "red";
	} else if (card.column === "in_progress") {
		statusGlyph = "◉";
		statusColor = "yellow";
	} else if (card.column === "done" && card.merged) {
		statusGlyph = "✔";
		statusColor = "magenta";
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

	const [titleLine1, titleLine2] = wrapTitle(card.title, cardWidth);

	// Compute elapsed time accounting for pause duration
	let elapsedMs: number | null = null;
	if (card.column === "in_progress" && card.startedAt !== undefined) {
		const pauseOffset = (card.pauseAccumulated ?? 0) + (card.pausedAt ? now - card.pausedAt : 0);
		elapsedMs = Math.max(0, now - card.startedAt - pauseOffset);
	}

	return (
		<Box
			flexDirection="row"
			paddingX={0}
			marginBottom={0}
			borderStyle="single"
			borderColor={
				card.hasError || card.killed
					? "red"
					: card.skipped
						? "gray"
						: isPausedInProgress
							? "gray"
							: isSelected
								? "yellow"
								: card.merged
									? "magenta"
									: "gray"
			}
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
				{/* stripDoubleWidth + padEnd ensures each row is always cardWidth terminal columns wide */}
				<Text bold={isSelected} dimColor={!isSelected}>
					{stripDoubleWidth(titleLine1).padEnd(cardWidth)}
				</Text>
				<Text bold={isSelected} dimColor={!isSelected}>
					{stripDoubleWidth(titleLine2).padEnd(cardWidth)}
				</Text>

				{/* Last provider output line — always rendered to keep CARD_HEIGHT stable */}
				{/* padEnd ensures the row is always cardWidth wide, preventing border from shifting */}
				<Text dimColor>
					{stripDoubleWidth(
						card.column === "in_progress" ? getLastOutputLine(card.outputLog, cardWidth) : "",
					).padEnd(cardWidth)}
				</Text>

				{/* Status row — always rendered exactly once for stable CARD_HEIGHT */}
				{card.column === "in_progress" ? (
					// Spinner appears immediately; elapsed time only once startedAt is available
					// minWidth guarantees the row stays as wide as other rows (cardWidth + 2)
					// even before startedAt is set, preventing the card border from shrinking.
					<Box flexDirection="row" marginTop={0} minWidth={cardWidth + 2}>
						{isPausedInProgress ? (
							<Text color="gray">{"⏸"}</Text>
						) : (
							<Text color="yellow">
								<Spinner type="dots" />
							</Text>
						)}
						<Text color={isPausedInProgress ? "gray" : "yellow"} dimColor={isPausedInProgress}>
							{elapsedMs !== null ? ` ${formatElapsed(elapsedMs)}` : ""}
						</Text>
					</Box>
				) : card.column === "done" &&
					card.startedAt !== undefined &&
					card.finishedAt !== undefined ? (
					<Text color={card.merged ? "magenta" : "green"}>
						{"✔ "}
						{formatElapsed(card.finishedAt - card.startedAt)}
					</Text>
				) : card.killed ? (
					<Text color="red">KILLED</Text>
				) : card.skipped ? (
					<Text color="gray">SKIPPED</Text>
				) : card.hasError && !card.killed && !card.skipped ? (
					<Text color="red">FAILED</Text>
				) : (
					// Empty row for backlog and done-without-timing — maintains CARD_HEIGHT
					<Text>{" ".repeat(cardWidth)}</Text>
				)}
			</Box>
		</Box>
	);
}
