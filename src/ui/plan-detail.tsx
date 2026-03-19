import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { PlannedIssue } from "../types/index.js";
import { useTerminalSize } from "./use-terminal-size.js";

interface PlanDetailProps {
	issue: PlannedIssue;
	onBack: () => void;
	onEdit: () => void;
}

const SIDEBAR_TOTAL_WIDTH = 30;

export function PlanDetail({ issue, onBack, onEdit }: PlanDetailProps) {
	const { columns: terminalCols, rows: terminalRows } = useTerminalSize();
	const maxWidth = Math.max(1, terminalCols - SIDEBAR_TOTAL_WIDTH - 4);
	const [scrollOffset, setScrollOffset] = useState(0);

	useInput((input, key) => {
		if (key.escape) {
			onBack();
			return;
		}
		if (input === "e") {
			onEdit();
			return;
		}
		if (key.upArrow) {
			setScrollOffset((prev) => Math.max(0, prev - 1));
		}
		if (key.downArrow) {
			setScrollOffset((prev) => prev + 1);
		}
	});

	// Build content lines for scrollable body
	const contentLines: { text: string; color: string; bold?: boolean; dimColor?: boolean }[] = [];

	// Description
	if (issue.description) {
		const descLines = issue.description.split("\n");
		for (const line of descLines) {
			contentLines.push({ text: line, color: "white" });
		}
		contentLines.push({ text: "", color: "white" });
	}

	// Acceptance criteria
	if (issue.acceptanceCriteria.length > 0) {
		contentLines.push({ text: "ACCEPTANCE CRITERIA", color: "yellow", bold: true });
		for (const criterion of issue.acceptanceCriteria) {
			contentLines.push({ text: `\u2610 ${criterion}`, color: "white" });
		}
		contentLines.push({ text: "", color: "white" });
	}

	// Dependencies
	if (issue.dependsOn.length > 0) {
		contentLines.push({ text: "DEPENDENCIES", color: "yellow", bold: true });
		contentLines.push({
			text: `Depends on: ${issue.dependsOn.map((d) => `#${d}`).join(", ")}`,
			color: "gray",
			dimColor: true,
		});
		contentLines.push({ text: "", color: "white" });
	}

	// Relevant files
	if (issue.relevantFiles.length > 0) {
		contentLines.push({ text: "RELEVANT FILES", color: "yellow", bold: true });
		for (const file of issue.relevantFiles) {
			contentLines.push({ text: `  ${file}`, color: "gray", dimColor: true });
		}
	}

	// Header overhead: title(1) + deps(1) + separator(1) + border(2) = 5
	const bodyHeight = Math.max(1, terminalRows - 5);
	const clampedOffset = Math.min(scrollOffset, Math.max(0, contentLines.length - bodyHeight));
	const visibleLines = contentLines.slice(clampedOffset, clampedOffset + bodyHeight);

	return (
		<Box
			width={terminalCols - SIDEBAR_TOTAL_WIDTH}
			flexDirection="column"
			borderStyle="single"
			borderColor="yellow"
			paddingX={1}
			paddingY={0}
		>
			{/* Header: order + title */}
			<Box>
				<Text color="yellow" bold>
					{`#${issue.order} `}
				</Text>
				<Text color="white" bold wrap="truncate">
					{issue.title}
				</Text>
			</Box>

			{/* Dependency info */}
			{issue.dependsOn.length > 0 && (
				<Box>
					<Text color="gray" dimColor>
						{"\u2192 depends on: "}
						{issue.dependsOn.map((d) => `#${d}`).join(", ")}
					</Text>
				</Box>
			)}

			{/* Separator */}
			<Text color="yellow" dimColor>
				{"\u2500".repeat(Math.max(0, maxWidth))}
			</Text>

			{/* Scrollable body */}
			<Box height={bodyHeight} flexDirection="column" overflow="hidden">
				{visibleLines.map((line, i) => {
					const { text, color, bold: isBold, dimColor: isDim } = line;
					return (
						// biome-ignore lint/suspicious/noArrayIndexKey: content lines have no stable key
						<Text key={i} color={color} bold={isBold} dimColor={isDim} wrap="truncate">
							{text}
						</Text>
					);
				})}
			</Box>
		</Box>
	);
}
