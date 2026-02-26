import { Box, Text, useStdout } from "ink";

interface ProgressHeaderProps {
	total: number;
	done: number;
	running: number;
	workComplete: boolean;
	paused?: boolean;
}

export function ProgressHeader({
	total,
	done,
	running,
	workComplete,
	paused,
}: ProgressHeaderProps) {
	const { stdout } = useStdout();

	if (total === 0) {
		return null;
	}

	const progress = (done / total) * 100;
	const pct = Math.round(progress);

	// Calculate bar length to fill available terminal width.
	// Sidebar: 28 cols (content+border+padding). Header box: borderStyle="single" (+2) + paddingX={1} (+2) + space (1).
	// Total non-bar columns: 28 (sidebar) + 2 (header border) + 2 (header paddingX) + 1 (space) + stats.
	const statsText = `${done}/${total} (${pct}%)${running > 0 ? ` (${running} running)` : ""}`;
	const SIDEBAR_WIDTH = 28;
	const boardWidth = (stdout?.columns ?? 80) - SIDEBAR_WIDTH - 2; // subtract header border
	const progressBarLength = Math.max(10, boardWidth - 2 - 1 - statsText.length); // paddingX(2) + space(1)

	const completedBars = Math.round((progress / 100) * progressBarLength);
	const remainingBars = progressBarLength - completedBars;

	const barColor = workComplete ? "green" : paused ? "yellow" : "cyan";
	const borderColor = workComplete ? "green" : paused ? "yellow" : "gray";

	const progressBar = (
		<Text color={barColor}>
			{"█".repeat(completedBars)}
			{"░".repeat(remainingBars)}
		</Text>
	);

	return (
		<Box
			flexDirection="row"
			justifyContent="space-between"
			alignItems="center"
			paddingX={1}
			paddingY={0}
			borderStyle="single"
			borderColor={borderColor}
			marginBottom={1}
		>
			<Text>
				{progressBar}
				<Text> </Text>
				<Text bold>{done}</Text>
				<Text>/</Text>
				<Text>{total}</Text>
				<Text> </Text>
				<Text dimColor>{`(${pct}%)`}</Text>
				{running > 0 && <Text dimColor>{` (${running} running)`}</Text>}
			</Text>
		</Box>
	);
}
