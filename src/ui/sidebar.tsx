import { Box, Text } from "ink";
import React from "react";

interface SidebarProps {
	provider: string;
	source: string;
}

export function Sidebar({ provider, source }: SidebarProps) {
	return (
		<Box flexDirection="column" width={18} borderStyle="single" paddingX={1}>
			<Text bold color="yellow">
				◆ LISA
			</Text>
			<Box height={1} />
			<Text dimColor>Provider</Text>
			<Text color="cyan">{provider}</Text>
			<Box height={1} />
			<Text dimColor>Source</Text>
			<Text color="cyan">{source}</Text>
			<Box flexGrow={1} />
			<Text dimColor>[q] Quit</Text>
		</Box>
	);
}
