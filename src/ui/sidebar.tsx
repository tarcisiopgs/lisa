import { basename } from "node:path";
import { Box, Text } from "ink";

interface SidebarProps {
	provider: string;
	source: string;
	cwd: string;
}

export function Sidebar({ provider, source, cwd }: SidebarProps) {
	return (
		<Box flexDirection="column" width={22} borderStyle="single" paddingX={1}>
			<Text>{" /\\_/\\"}</Text>
			<Text>{"( ^.^ )"}</Text>
			<Text>{" > ♥ <"}</Text>
			<Box height={1} />
			<Text dimColor>Provider</Text>
			<Text color="cyan">{provider}</Text>
			<Box height={1} />
			<Text dimColor>Source</Text>
			<Text color="cyan">{source}</Text>
			<Box height={1} />
			<Text dimColor>Directory</Text>
			<Text color="cyan">{basename(cwd)}</Text>
			<Box flexGrow={1} />
			<Text dimColor>[q] Quit</Text>
		</Box>
	);
}
