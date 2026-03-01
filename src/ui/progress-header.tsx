import { Box, Text, useStdout } from "ink";

interface ProgressHeaderProps {
	total: number;
	done: number;
	running: number;
	workComplete: boolean;
	paused?: boolean;
	watching?: boolean;
	availableWidth?: number;
}

const OVERHEAD = 4;

export function ProgressHeader({
	total,
	done,
	running,
	workComplete,
	paused,
	watching,
	availableWidth,
}: ProgressHeaderProps) {
	const { stdout } = useStdout();

	if (total === 0) {
		return null;
	}

	const progress = (done / total) * 100;
	const pct = Math.round(progress);

	const barColor = workComplete ? "green" : watching ? "cyan" : paused ? "yellow" : "cyan";
	const borderColor = workComplete ? "green" : watching ? "cyan" : paused ? "yellow" : "gray";

	const statsText = `${done}/${total} (${pct}%)${running > 0 ? ` (${running} running)` : ""}`;
	const statsLength = statsText.length;
	const terminalWidth = availableWidth ?? stdout?.columns ?? 80;
	const barWidth = Math.max(10, terminalWidth - statsLength - OVERHEAD);

	const completedBars = Math.round((progress / 100) * barWidth);
	const remainingBars = barWidth - completedBars;

	const progressBar = (
		<Box width={barWidth}>
			<Text color={barColor}>
				{"█".repeat(completedBars)}
				{"░".repeat(remainingBars)}
			</Text>
		</Box>
	);

	return (
		<Box
			flexDirection="row"
			alignItems="center"
			paddingX={1}
			paddingY={0}
			borderStyle="single"
			borderColor={borderColor}
			marginBottom={1}
		>
			{progressBar}
			<Text bold>{done}</Text>
			<Text>/</Text>
			<Text>{total}</Text>
			<Text> </Text>
			<Text dimColor>{`(${pct}%)`}</Text>
			{running > 0 && <Text dimColor>{` (${running} running)`}</Text>}
			{watching && <Text color="cyan">{" watching..."}</Text>}
		</Box>
	);
}
