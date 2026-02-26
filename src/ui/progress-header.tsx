import { Box, Text } from "ink";

interface ProgressHeaderProps {
	total: number;
	done: number;
	running: number;
	workComplete: boolean;
}

export function ProgressHeader({
	total,
	done,
	running,
	workComplete,
}: ProgressHeaderProps) {
	if (total === 0) {
		return null;
	}

	const progress = total > 0 ? (done / total) * 100 : 0;
	const progressBarLength = 20;
	const completedBars = Math.round((progress / 100) * progressBarLength);
	const remainingBars = progressBarLength - completedBars;

	const progressBar = (
		<Text color={workComplete ? "green" : "cyan"}>
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
			borderColor={workComplete ? "green" : "gray"}
			marginBottom={1}
		>
			<Text>
				{progressBar}
				<Text> </Text>
				<Text bold>{done}</Text>
				<Text>/</Text>
				<Text>{total}</Text>
				<Text> </Text>
				<Text dimColor>{`(${Math.round(progress)}%)`}</Text>
				{running > 0 && (
					<Text dimColor>{` (${running} running)`}</Text>
				)}
			</Text>
		</Box>
	);
}
