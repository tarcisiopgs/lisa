import { Box, Text } from "ink";
import type { PlannedIssue } from "../types/index.js";
import { useTerminalSize } from "./use-terminal-size.js";

interface PlanReviewProps {
	goal: string;
	issues: PlannedIssue[];
	selectedIndex: number;
	onNavigate: (index: number) => void;
	onViewDetail: (index: number) => void;
	onEdit: (index: number) => void;
	onDelete: (index: number) => void;
	onApprove: () => void;
	onCancel: () => void;
}

const SIDEBAR_TOTAL_WIDTH = 30;
const MAX_VISIBLE_FILES = 3;

export function PlanReview({ goal, issues, selectedIndex }: PlanReviewProps) {
	const { columns: terminalCols } = useTerminalSize();
	const maxWidth = Math.max(1, terminalCols - SIDEBAR_TOTAL_WIDTH - 4);

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
					{"PLAN: "}
				</Text>
				<Text color="white" bold wrap="truncate">
					{goal}
				</Text>
			</Box>

			<Text color="yellow" dimColor>
				{"\u2500".repeat(Math.max(0, maxWidth))}
			</Text>

			{/* Issue list */}
			<Box flexDirection="column" flexGrow={1}>
				{issues.length === 0 && (
					<Box marginTop={1}>
						<Text color="gray" dimColor>
							No issues in the plan.
						</Text>
					</Box>
				)}
				{issues.map((issue, i) => {
					const isSelected = i === selectedIndex;
					const extraFiles = issue.relevantFiles.length - MAX_VISIBLE_FILES;
					const visibleFiles = issue.relevantFiles.slice(0, MAX_VISIBLE_FILES);

					return (
						<Box
							key={issue.order}
							flexDirection="column"
							borderStyle={isSelected ? "single" : undefined}
							borderColor={isSelected ? "yellow" : undefined}
							paddingX={isSelected ? 1 : 0}
							marginLeft={isSelected ? 0 : 2}
							marginTop={i === 0 ? 0 : 0}
						>
							<Box flexDirection="row">
								{/* Indicator */}
								<Text color={isSelected ? "yellow" : "gray"}>{isSelected ? "\u25B8 " : "  "}</Text>

								{/* Order number */}
								<Text color="yellow" bold>
									{`${issue.order}. `}
								</Text>

								{/* Status glyph */}
								<Text color="gray">{"\u25CB "}</Text>

								{/* Title */}
								<Text color="white" bold={isSelected} wrap="truncate">
									{issue.title}
								</Text>
							</Box>

							{/* Dependencies */}
							{issue.dependsOn.length > 0 && (
								<Box marginLeft={5}>
									<Text color="gray" dimColor>
										{"\u2192 depends on: "}
										{issue.dependsOn.map((d) => `#${d}`).join(", ")}
									</Text>
								</Box>
							)}

							{/* Relevant files */}
							{visibleFiles.length > 0 && (
								<Box marginLeft={5} flexDirection="row">
									<Text color="gray" dimColor>
										{visibleFiles.join(", ")}
										{extraFiles > 0 ? ` +${extraFiles} more` : ""}
									</Text>
								</Box>
							)}
						</Box>
					);
				})}
			</Box>
		</Box>
	);
}
