import { exec } from "node:child_process";
import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import { useEffect, useMemo, useRef, useState } from "react";
import { logLineColor } from "../output/line-color.js";
import { formatElapsed } from "./format.js";
import type { KanbanCard } from "./state.js";
import { useTerminalSize } from "./use-terminal-size.js";

export function openUrl(url: string): void {
	const platform = process.platform;
	let command: string;

	if (platform === "darwin") {
		command = `open "${url}"`;
	} else if (platform === "linux") {
		command = `xdg-open "${url}"`;
	} else if (platform === "win32") {
		command = `start "" "${url}"`;
	} else {
		return;
	}

	exec(command, (error) => {
		if (error) {
			console.error("Failed to open URL:", error.message);
		}
	});
}

interface IssueDetailProps {
	card: KanbanCard;
	onBack: () => void;
	assignees?: string[];
	showReviewerPicker?: boolean;
	reviewerPickerIndex?: number;
}

function hyperlink(url: string, text: string): string {
	return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

/** Strip ANSI escape sequences (CSI, OSC, charset) and carriage returns. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — must match ESC, BEL control chars in ANSI sequences
const ANSI_CSI = /\x1b\[[0-9;]*[A-Za-z]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — must match ESC + BEL in OSC sequences
const ANSI_OSC = /\x1b\][^\x07]*\x07/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — must match ESC in charset sequences
const ANSI_CHARSET = /\x1b\([A-Z]/g;

function stripAnsi(str: string): string {
	return str
		.replace(ANSI_CSI, "")
		.replace(ANSI_OSC, "")
		.replace(ANSI_CHARSET, "")
		.replace(/\r/g, "");
}

/** Truncate a line to at most maxWidth visible characters. */
function truncateLine(line: string, maxWidth: number): string {
	const clean = stripAnsi(line);
	if (clean.length <= maxWidth) return clean;
	return `${clean.slice(0, maxWidth - 1)}…`;
}

/**
 * Pre-process raw provider output into display lines.
 * Handles \r\n, standalone \r (progress bars), and strips ANSI.
 */
function processOutputLines(raw: string): string[] {
	const normalized = raw.replace(/\r\n/g, "\n");
	return normalized.split("\n").map((line) => {
		// \r within a line means "overwrite from start" — keep last segment
		const parts = line.split("\r");
		return parts[parts.length - 1] ?? "";
	});
}

function scrollBar(pct: number, width = 8): string {
	const filled = Math.round((pct / 100) * width);
	return "▓".repeat(filled) + "░".repeat(width - filled);
}

export function statusLabel(
	column: string,
	hasError?: boolean,
	killed?: boolean,
	skipped?: boolean,
	merged?: boolean,
): { text: string; color: string } {
	if (killed) return { text: "KILLED", color: "red" };
	if (skipped) return { text: "SKIPPED", color: "gray" };
	if (hasError) return { text: "FAILED", color: "red" };
	if (column === "in_progress") return { text: "IN PROGRESS", color: "yellow" };
	if (column === "done" && merged) return { text: "MERGED", color: "magenta" };
	if (column === "done") return { text: "DONE", color: "green" };
	return { text: "QUEUED", color: "white" };
}

export function IssueDetail({
	card,
	onBack,
	assignees,
	showReviewerPicker,
	reviewerPickerIndex = 0,
}: IssueDetailProps) {
	const [now, setNow] = useState(Date.now());
	const [logScrollOffset, setLogScrollOffset] = useState(0);
	const [userScrolled, setUserScrolled] = useState(false);
	const prevOutputLen = useRef(card.outputLog.length);

	const isPausedInProgress = card.column === "in_progress" && !!card.pausedAt;

	useEffect(() => {
		if (card.column !== "in_progress" || isPausedInProgress) return;
		const interval = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(interval);
	}, [card.column, isPausedInProgress]);

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
		if (_input === "o" && card.prUrls.length > 0) {
			for (const url of card.prUrls) {
				openUrl(url);
			}
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

	const { columns: terminalCols, rows: terminalRows } = useTerminalSize();
	// sidebar width (28) + sidebar border (2) = 30
	const SIDEBAR_TOTAL_WIDTH = 30;

	// Available content width: total - sidebar(30) - border(2) - paddingX(2)
	const maxLineWidth = Math.max(1, terminalCols - SIDEBAR_TOTAL_WIDTH - 4);

	// Header overhead: border(2) + ID row(1) + title(1) + separator(1) + log header(1) = 6
	// Plus conditional rows: log file path(1), PR URLs (N), PR metadata (0-1)
	const prCount = card.prUrls.length > 0 ? card.prUrls.length : 0;
	const logFileRow = card.logFile ? 1 : 0;
	const cardReviewers = card.reviewers ?? [];
	const hasPrMeta = card.prUrls.length > 0 && (cardReviewers.length > 0 || assignees?.length);
	const prMetaRow = hasPrMeta ? 1 : 0;
	const pickerRows = showReviewerPicker
		? Math.min((card.availableReviewers ?? []).length + 2, 12)
		: 0;
	const ciRow = card.ciStatus ? 1 : 0;
	const autoMergeRow = card.autoMergeStatus ? 1 : 0;
	const headerOverhead = 6 + prCount + logFileRow + ciRow + autoMergeRow + prMetaRow + pickerRows;
	const bodyRows = Math.max(1, terminalRows - headerOverhead);

	const lines = useMemo(() => processOutputLines(card.outputLog), [card.outputLog]);
	const startLine = Math.max(0, lines.length - bodyRows - logScrollOffset);
	const visibleLines = useMemo(
		() => lines.slice(startLine, startLine + bodyRows).map((l) => truncateLine(l, maxLineWidth)),
		[lines, startLine, bodyRows, maxLineWidth],
	);

	const status = statusLabel(card.column, card.hasError, card.killed, card.skipped, card.merged);

	let elapsedDisplay: string | null = null;
	let isRunning = false;
	if (card.column === "in_progress" && card.startedAt !== undefined) {
		const pauseOffset = (card.pauseAccumulated ?? 0) + (card.pausedAt ? now - card.pausedAt : 0);
		elapsedDisplay = formatElapsed(Math.max(0, now - card.startedAt - pauseOffset));
		isRunning = !isPausedInProgress;
	} else if (
		card.column === "done" &&
		card.startedAt !== undefined &&
		card.finishedAt !== undefined
	) {
		elapsedDisplay = formatElapsed(card.finishedAt - card.startedAt);
	}

	// Decorative separator: ╠═══...═══╣ — memoized, only recomputed on terminal resize
	const separator = useMemo(() => {
		const separatorInner = Math.max(0, terminalCols - SIDEBAR_TOTAL_WIDTH - 4);
		return `╠${"═".repeat(Math.max(0, separatorInner - 2))}╣`;
	}, [terminalCols]);

	// Scroll position indicator
	const totalLines = lines.length;
	const scrollPctNum =
		totalLines <= bodyRows ? 100 : Math.round(((startLine + bodyRows) / totalLines) * 100);

	return (
		<Box
			width={terminalCols - SIDEBAR_TOTAL_WIDTH}
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
					{card.substatus && card.column === "in_progress" && (
						<Text color="yellow" dimColor>
							{" "}
							· {card.substatus}
						</Text>
					)}
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
					{isPausedInProgress && elapsedDisplay && (
						<Box flexDirection="row" marginRight={2}>
							<Text color="gray">{"⏸ "}</Text>
							<Text color="gray" bold>
								{elapsedDisplay}
							</Text>
						</Box>
					)}
					{!isRunning && !isPausedInProgress && elapsedDisplay && (
						<Box flexDirection="row" marginRight={2}>
							<Text color={status.color}>{"✔ "}</Text>
							<Text color={status.color} bold>
								{elapsedDisplay}
							</Text>
						</Box>
					)}
				</Box>
			</Box>

			{/* Header row 2: title (truncated to single line) */}
			<Box marginTop={0}>
				<Text color="white" bold wrap="truncate">
					{truncateLine(card.title, maxLineWidth)}
				</Text>
			</Box>

			{/* PR URL(s) if available */}
			{card.prUrls.length > 0 &&
				card.prUrls.map((url, i) => (
					<Box marginTop={0} key={url}>
						<Text color="yellow" dimColor>
							{card.prUrls.length === 1 ? "PR: " : `PR ${i + 1}: `}
						</Text>
						<Text color="yellow" wrap="truncate">
							{hyperlink(url, truncateLine(url, maxLineWidth - 5))}
						</Text>
					</Box>
				))}

			{/* CI status */}
			{card.ciStatus && (
				<Box marginTop={0}>
					<Text color="gray" dimColor>
						{"CI: "}
					</Text>
					<Text
						color={
							card.ciStatus === "passing" ? "green" : card.ciStatus === "failing" ? "red" : "yellow"
						}
					>
						{card.ciStatus === "passing"
							? "✔ passing"
							: card.ciStatus === "failing"
								? "✖ failing"
								: "⏳ pending"}
					</Text>
				</Box>
			)}

			{/* Auto-merge status */}
			{card.autoMergeStatus && (
				<Box marginTop={0}>
					<Text color="gray" dimColor>
						{"MERGE: "}
					</Text>
					<Text
						color={
							card.autoMergeStatus === "merged"
								? "magenta"
								: card.autoMergeStatus === "failed"
									? "red"
									: "yellow"
						}
					>
						{card.autoMergeStatus === "merged"
							? `✔ merged (${card.prUrls.length} PR${card.prUrls.length > 1 ? "s" : ""})`
							: card.autoMergeStatus === "failed"
								? "✖ failed"
								: card.autoMergeStatus === "merging"
									? "⏳ merging..."
									: "⏳ waiting for CI"}
					</Text>
				</Box>
			)}

			{/* PR metadata: reviewers + assignees */}
			{hasPrMeta && (
				<Box marginTop={0} flexDirection="row">
					{cardReviewers.length > 0 ? (
						<>
							<Text color="cyan" dimColor>
								{"REVIEWERS: "}
							</Text>
							<Text color="cyan">{cardReviewers.join(", ")}</Text>
						</>
					) : null}
					{cardReviewers.length > 0 && assignees?.length ? (
						<Text color="gray" dimColor>
							{" │ "}
						</Text>
					) : null}
					{assignees?.length ? (
						<>
							<Text color="green" dimColor>
								{"ASSIGNEES: "}
							</Text>
							<Text color="green">
								{assignees.map((a) => (a === "self" ? "you" : a)).join(", ")}
							</Text>
						</>
					) : null}
				</Box>
			)}

			{/* Reviewer picker overlay */}
			{showReviewerPicker && (
				<Box marginTop={0} flexDirection="column">
					<Text color="yellow">{"────────────────────────"}</Text>
					<Text color="yellow" bold>
						{"TOGGLE REVIEWERS"}
					</Text>
					{(card.availableReviewers ?? []).length === 0 ? (
						<Text color="gray" dimColor>
							{"No contributors found"}
						</Text>
					) : (
						(card.availableReviewers ?? []).slice(0, 10).map((username, i) => {
							const isActive = cardReviewers.includes(username);
							const isSelected = i === reviewerPickerIndex;
							return (
								<Box key={username} flexDirection="row">
									<Text color={isSelected ? "yellow" : "white"}>{isSelected ? "▸ " : "  "}</Text>
									<Text color={isActive ? "cyan" : "gray"}>{isActive ? "[✓] " : "[ ] "}</Text>
									<Text color={isActive ? "cyan" : "white"} bold={isActive}>
										{username}
									</Text>
								</Box>
							);
						})
					)}
					<Text color="gray" dimColor>
						{"[↑↓] navigate  [space] toggle  [Esc] close"}
					</Text>
				</Box>
			)}

			{/* Log file path (truncated to single line) */}
			{card.logFile && (
				<Box marginTop={0}>
					<Text color="gray" dimColor wrap="truncate">
						{`LOG: ${truncateLine(card.logFile, maxLineWidth - 5)}`}
					</Text>
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
				<Box flexDirection="row">
					<Text color="gray" dimColor>
						{"OUTPUT"}
					</Text>
					{totalLines > 0 && <Text color="gray" dimColor>{` · ${totalLines}L`}</Text>}
				</Box>
				{userScrolled && (
					<Text color="yellow" dimColor>
						{scrollBar(scrollPctNum)}
					</Text>
				)}
				{!userScrolled && totalLines > bodyRows && (
					<Text color="gray" dimColor>
						{"live"}
					</Text>
				)}
			</Box>

			{/* Log body */}
			<Box height={bodyRows} flexDirection="column" overflow="hidden">
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
							<Text key={i} color={color} dimColor={color === "white"} wrap="truncate">
								{line}
							</Text>
						);
					})
				)}
			</Box>
		</Box>
	);
}
