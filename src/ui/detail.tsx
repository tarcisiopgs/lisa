import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import type { KanbanCard } from "./state.js";

function formatElapsed(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	if (minutes > 0) return `${minutes}m ${remainingSeconds}s`;
	return `${seconds}s`;
}

interface IssueDetailProps {
	card: KanbanCard;
	onBack: () => void;
}

export function IssueDetail({ card, onBack }: IssueDetailProps) {
	const [now, setNow] = useState(Date.now());
	const [logScrollOffset, setLogScrollOffset] = useState(0);
	const [userScrolled, setUserScrolled] = useState(false);
	const prevOutputLen = useRef(card.outputLog.length);

	useEffect(() => {
		if (card.column !== "in_progress") return;
		const interval = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(interval);
	}, [card.column]);

	useEffect(() => {
		if (!userScrolled && card.outputLog.length !== prevOutputLen.current) {
			prevOutputLen.current = card.outputLog.length;
			setLogScrollOffset(0);
		}
	}, [card.outputLog, userScrolled]);

	useInput((_input, key) => {
		if (key.escape) {
			onBack();
			return;
		}
		if (key.upArrow) {
			setUserScrolled(true);
			setLogScrollOffset((prev) => prev + 1);
		}
		if (key.downArrow) {
			setLogScrollOffset((prev) => {
				const next = Math.max(0, prev - 1);
				if (next === 0) setUserScrolled(false);
				return next;
			});
		}
	});

	const terminalRows = process.stdout.rows ?? 24;
	const bodyRows = Math.max(1, terminalRows - 8);

	const lines = card.outputLog.split("\n");
	const startLine = Math.max(0, lines.length - bodyRows - logScrollOffset);
	const visibleLines = lines.slice(startLine, startLine + bodyRows);

	let elapsedDisplay: string | null = null;
	if (card.column === "in_progress" && card.startedAt !== undefined) {
		elapsedDisplay = formatElapsed(now - card.startedAt);
	} else if (
		card.column === "done" &&
		card.startedAt !== undefined &&
		card.finishedAt !== undefined
	) {
		elapsedDisplay = `✓ ${formatElapsed(card.finishedAt - card.startedAt)}`;
	}

	const divider = "─".repeat(Math.max(0, (process.stdout.columns ?? 80) - 4));

	return (
		<Box flexGrow={1} flexDirection="column" borderStyle="single" paddingX={1}>
			<Box flexDirection="row" justifyContent="space-between">
				<Text bold color="cyan">
					{card.id}
				</Text>
				<Text dimColor>{card.column}</Text>
				{elapsedDisplay !== null && <Text color="yellow">{elapsedDisplay}</Text>}
			</Box>
			<Text bold>{card.title}</Text>
			{card.prUrl !== undefined && card.prUrl.length > 0 && <Text color="blue">{card.prUrl}</Text>}
			<Box height={1} />
			<Text dimColor>{divider}</Text>
			<Box height={1} />
			{card.outputLog.length === 0 ? (
				<Text dimColor>Waiting for provider output...</Text>
			) : (
				visibleLines.map((line, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: log lines have no stable key
					<Text key={i}>{line}</Text>
				))
			)}
			<Box flexGrow={1} />
			<Box justifyContent="flex-end">
				<Text dimColor>{"[↑↓] scroll   [Esc] back"}</Text>
			</Box>
		</Box>
	);
}
