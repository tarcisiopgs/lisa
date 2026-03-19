import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import { useState } from "react";
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

export function PlanChat({ messages, isThinking, onSend, onCancel }: PlanChatProps) {
	const [inputBuffer, setInputBuffer] = useState("");
	const { columns: terminalCols, rows: terminalRows } = useTerminalSize();
	const maxWidth = Math.max(1, terminalCols - SIDEBAR_TOTAL_WIDTH - 4);

	// Reserve rows for: header(1) + separator(1) + input separator(1) + input row(1) + border(2) = 6
	const messageAreaHeight = Math.max(1, terminalRows - 6);

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
			}
			return;
		}
		if (key.backspace || key.delete) {
			setInputBuffer((prev) => prev.slice(0, -1));
			return;
		}
		// Only append printable characters (ignore control sequences)
		if (
			input &&
			!key.ctrl &&
			!key.meta &&
			!key.upArrow &&
			!key.downArrow &&
			!key.leftArrow &&
			!key.rightArrow &&
			!key.tab
		) {
			setInputBuffer((prev) => prev + input);
		}
	});

	// Flatten messages into display lines and take the tail that fits
	const displayLines: { role: "user" | "ai"; text: string }[] = [];
	for (const msg of messages) {
		const lines = msg.content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			displayLines.push({ role: msg.role, text: i === 0 ? (lines[i] ?? "") : (lines[i] ?? "") });
		}
	}
	const visibleMessages = displayLines.slice(-messageAreaHeight);

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
			<Box>
				<Text color="yellow" bold>
					{"PLAN"}
				</Text>
				<Text color="gray">{" \u2014 "}</Text>
				<Text color="white">Describe your goal</Text>
			</Box>

			<Text color="yellow" dimColor>
				{"\u2500".repeat(Math.max(0, maxWidth))}
			</Text>

			{/* Message area */}
			<Box height={messageAreaHeight} flexDirection="column" overflow="hidden">
				{visibleMessages.length === 0 && !isThinking && (
					<Box marginTop={1}>
						<Text color="gray" dimColor>
							What would you like to plan? Describe the feature or goal.
						</Text>
					</Box>
				)}
				{visibleMessages.map((line, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: chat lines have no stable key
					<Box key={i} flexDirection="row">
						{line === displayLines.find((d) => d === line) ||
						i === 0 ||
						visibleMessages[i - 1]?.role !== line.role ? (
							<Text color={line.role === "user" ? "cyan" : "yellow"} bold>
								{line.role === "user" ? "You: " : "AI:  "}
							</Text>
						) : (
							<Text>{"     "}</Text>
						)}
						<Text color="white" wrap="truncate">
							{line.text}
						</Text>
					</Box>
				))}
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
