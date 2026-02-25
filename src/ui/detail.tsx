import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
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

function hyperlink(url: string, text: string): string {
	return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

function logLineColor(line: string): string {
	if (/error|Error|ERROR|✖/.test(line)) return "red";
	if (/warning|Warning|WARNING|warn/.test(line)) return "yellow";
	if (/✔|success|Success/.test(line)) return "green";
	return "white";
}

function statusLabel(column: string, hasError?: boolean): { text: string; color: string } {
	if (hasError) return { text: "FAILED", color: "red" };
	if (column === "in_progress") return { text: "IN PROGRESS", color: "yellow" };
	if (column === "done") return { text: "DONE", color: "green" };
	return { text: "QUEUED", color: "white" };
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

	const terminalCols = process.stdout.columns ?? 80;
	const terminalRows = process.stdout.rows ?? 24;
	// Header: ~6 rows, footer: ~2 rows, border: ~2 rows
	const bodyRows = Math.max(1, terminalRows - 10);

	const lines = card.outputLog.split("\n");
	const startLine = Math.max(0, lines.length - bodyRows - logScrollOffset);
	const visibleLines = lines.slice(startLine, startLine + bodyRows);

	const status = statusLabel(card.column, card.hasError);

	let elapsedDisplay: string | null = null;
	let isRunning = false;
	if (card.column === "in_progress" && card.startedAt !== undefined) {
		elapsedDisplay = formatElapsed(now - card.startedAt);
		isRunning = true;
	} else if (
		card.column === "done" &&
		card.startedAt !== undefined &&
		card.finishedAt !== undefined
	) {
		elapsedDisplay = formatElapsed(card.finishedAt - card.startedAt);
	}

	// Decorative separator: ╠═══...═══╣
	// sidebar width (28) + detail border (2) + detail padding (2) = 32
	const SIDEBAR_TOTAL_WIDTH = 28;
	const separatorInner = Math.max(0, terminalCols - SIDEBAR_TOTAL_WIDTH - 4);
	const separator = `╠${"═".repeat(Math.max(0, separatorInner - 2))}╣`;

	// Scroll position indicator
	const totalLines = lines.length;
	const scrollPct =
		totalLines <= bodyRows ? "100%" : `${Math.round(((startLine + bodyRows) / totalLines) * 100)}%`;

	return (
		<Box
			flexGrow={1}
			flexDirection="column"
			borderStyle="single"
			borderColor="yellow"
			paddingX={1}
			paddingY={0}
		>
			{/* Header row 1: ID + status badge + timer */}
			<Box flexDirection="row" justifyContent="space-between" marginTop={0}>
				<Box flexDirection="row">
					<Text color="yellow" bold>
						{card.id}
					</Text>
					<Text color="gray">{" │ "}</Text>
					<Text color={status.color} bold>
						{status.text}
					</Text>
				</Box>
				<Box flexDirection="row">
					{isRunning && elapsedDisplay && (
						<Box flexDirection="row" marginRight={2}>
							<Text color="yellow">
								<Spinner type="dots" />
							</Text>
							<Text color="yellow" bold>{` ${elapsedDisplay}`}</Text>
						</Box>
					)}
					{!isRunning && elapsedDisplay && (
						<Box flexDirection="row" marginRight={2}>
							<Text color="green">{"✔ "}</Text>
							<Text color="green" bold>
								{elapsedDisplay}
							</Text>
						</Box>
					)}
				</Box>
			</Box>

			{/* Header row 2: title */}
			<Box marginTop={0}>
				<Text color="white" bold>
					{card.title}
				</Text>
			</Box>

			{/* PR URL if available */}
			{card.prUrl !== undefined && card.prUrl.length > 0 && (
				<Box marginTop={0}>
					<Text color="yellow" dimColor>
						{"PR: "}
					</Text>
					<Text color="yellow">{hyperlink(card.prUrl, card.prUrl)}</Text>
				</Box>
			)}

			{/* Decorative separator */}
			<Box>
				<Text color="yellow" dimColor>
					{separator}
				</Text>
			</Box>

			{/* Log header */}
			<Box flexDirection="row" justifyContent="space-between">
				<Text color="gray" dimColor>
					{"PROVIDER OUTPUT"}
				</Text>
				{userScrolled && <Text color="yellow" dimColor>{`scroll ${scrollPct}`}</Text>}
				{!userScrolled && totalLines > bodyRows && (
					<Text color="gray" dimColor>
						{"auto-scroll"}
					</Text>
				)}
			</Box>

			{/* Log body */}
			<Box flexGrow={1} flexDirection="column" overflow="hidden">
				{card.outputLog.length === 0 ? (
					<Box flexDirection="row" marginTop={1}>
						<Text color="yellow">
							<Spinner type="dots" />
						</Text>
						<Text color="gray" dimColor>
							{" Waiting for provider output..."}
						</Text>
					</Box>
				) : (
					visibleLines.map((line, i) => {
						const color = logLineColor(line);
						return (
							// biome-ignore lint/suspicious/noArrayIndexKey: log lines have no stable key
							<Text key={i} color={color} dimColor={color === "white"}>
								{line}
							</Text>
						);
					})
				)}
			</Box>
		</Box>
	);
}
