import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import { useEffect, useState } from "react";
import { useTerminalSize } from "./use-terminal-size.js";

interface ChatMessage {
	role: "user" | "ai";
	content: string;
}

interface PlanChatProps {
	messages: ChatMessage[];
	isThinking: boolean;
	onSend: (message: string) => void;
	onCancel: () => void;
}

const SIDEBAR_TOTAL_WIDTH = 30;

/**
 * Word-wraps a single line to fit within maxWidth columns.
 * Splits at word boundaries when possible; hard-breaks long words.
 */
function wrapLine(text: string, maxWidth: number): string[] {
	if (maxWidth <= 0) return [text];
	if (text.length <= maxWidth) return [text];

	const wrapped: string[] = [];
	let remaining = text;

	while (remaining.length > maxWidth) {
		let splitAt = remaining.lastIndexOf(" ", maxWidth);
		if (splitAt <= 0) {
			splitAt = maxWidth;
		}
		wrapped.push(remaining.slice(0, splitAt));
		remaining = remaining.slice(splitAt).trimStart();
	}
	if (remaining.length > 0) {
		wrapped.push(remaining);
	}

	return wrapped;
}

export function PlanChat({ messages, isThinking, onSend, onCancel }: PlanChatProps) {
	const [inputBuffer, setInputBuffer] = useState("");
	const [scrollOffset, setScrollOffset] = useState(0);
	const [userScrolled, setUserScrolled] = useState(false);
	const { columns: terminalCols, rows: terminalRows } = useTerminalSize();
	const maxWidth = Math.max(1, terminalCols - SIDEBAR_TOTAL_WIDTH - 4);

	// Reserve rows for: header(1) + separator(1) + scroll hint(1) + input separator(1) + input row(1) + border(2) = 7
	const messageAreaHeight = Math.max(1, terminalRows - 7);

	// Flatten messages into display lines, word-wrapping long lines to fit terminal width
	const displayLines: { role: "user" | "ai"; text: string; isFirst: boolean }[] = [];
	for (const msg of messages) {
		const rawLines = msg.content.split("\n");
		let isFirst = true;
		for (const rawLine of rawLines) {
			const wrapped = wrapLine(rawLine, maxWidth);
			for (const wrappedLine of wrapped) {
				displayLines.push({ role: msg.role, text: wrappedLine, isFirst });
				isFirst = false;
			}
		}
	}

	const totalLines = displayLines.length;
	const maxOffset = Math.max(0, totalLines - messageAreaHeight);

	// Auto-scroll to bottom when new messages arrive (unless user scrolled up)
	useEffect(() => {
		if (!userScrolled) {
			setScrollOffset(maxOffset);
		}
	}, [maxOffset, userScrolled]);

	useInput((input, key) => {
		if (key.escape) {
			onCancel();
			return;
		}
		if (key.return) {
			const trimmed = inputBuffer.trim();
			if (trimmed.length > 0) {
				onSend(trimmed);
				setInputBuffer("");
				setUserScrolled(false);
			}
			return;
		}
		if (key.backspace || key.delete) {
			setInputBuffer((prev) => prev.slice(0, -1));
			return;
		}
		if (key.upArrow) {
			setScrollOffset((prev) => {
				const next = Math.max(0, prev - 1);
				if (next < maxOffset) setUserScrolled(true);
				return next;
			});
			return;
		}
		if (key.downArrow) {
			setScrollOffset((prev) => {
				const next = Math.min(maxOffset, prev + 1);
				if (next >= maxOffset) setUserScrolled(false);
				return next;
			});
			return;
		}
		// Only append printable characters (ignore control sequences)
		if (input && !key.ctrl && !key.meta && !key.leftArrow && !key.rightArrow && !key.tab) {
			setInputBuffer((prev) => prev + input);
		}
	});

	const visibleMessages = displayLines.slice(scrollOffset, scrollOffset + messageAreaHeight);
	const hiddenAbove = scrollOffset;
	const hiddenBelow = Math.max(0, totalLines - scrollOffset - messageAreaHeight);

	return (
		<Box
			width={terminalCols - SIDEBAR_TOTAL_WIDTH}
			flexDirection="column"
			borderStyle="single"
			borderColor="yellow"
			paddingX={1}
			paddingY={0}
		>
			{/* Header */}
			<Box justifyContent="space-between">
				<Box>
					<Text color="yellow" bold>
						{"PLAN"}
					</Text>
					<Text color="gray">{" \u2014 "}</Text>
					<Text color="white">Describe your goal</Text>
				</Box>
				<Box>
					{userScrolled ? (
						<Text color="gray" dimColor>
							{"\u2191\u2193 scroll"}
						</Text>
					) : totalLines > messageAreaHeight ? (
						<Text color="green" dimColor>
							{"live"}
						</Text>
					) : null}
				</Box>
			</Box>

			<Text color="yellow" dimColor>
				{"\u2500".repeat(Math.max(0, maxWidth))}
			</Text>

			{/* Scroll-up hint */}
			{hiddenAbove > 0 ? (
				<Text color="gray" dimColor>
					{`\u2191 ${hiddenAbove} more`}
				</Text>
			) : (
				<Text> </Text>
			)}

			{/* Message area */}
			<Box height={messageAreaHeight} flexDirection="column" overflow="hidden">
				{visibleMessages.length === 0 && !isThinking && (
					<Box marginTop={1}>
						<Text color="gray" dimColor>
							What would you like to plan? Describe the feature or goal.
						</Text>
					</Box>
				)}
				{visibleMessages.map((line, i) => {
					const isNewMessage =
						line.isFirst && (i === 0 || visibleMessages[i - 1]?.role !== line.role);
					return (
						// biome-ignore lint/suspicious/noArrayIndexKey: chat lines have no stable key
						<Box key={i} flexDirection="row" marginTop={isNewMessage && i > 0 ? 1 : 0}>
							<Text
								color={line.role === "user" ? "cyan" : "white"}
								dimColor={line.role === "ai"}
								wrap="truncate"
							>
								{line.text}
							</Text>
						</Box>
					);
				})}
				{isThinking && (
					<Box flexDirection="row" marginTop={0}>
						<Text color="yellow">
							<Spinner type="dots" />
						</Text>
						<Text color="gray" dimColor>
							{" Analyzing..."}
						</Text>
					</Box>
				)}
			</Box>

			{/* Scroll-down hint */}
			{hiddenBelow > 0 ? (
				<Text color="gray" dimColor>
					{`\u2193 ${hiddenBelow} more`}
				</Text>
			) : (
				<Text> </Text>
			)}

			{/* Input separator */}
			<Text color="yellow" dimColor>
				{"\u2500".repeat(Math.max(0, maxWidth))}
			</Text>

			{/* Input row */}
			<Box flexDirection="row">
				<Text color="cyan" bold>
					{"> "}
				</Text>
				<Text color="white">{inputBuffer}</Text>
				<Text color="gray">{"_"}</Text>
			</Box>
		</Box>
	);
}
