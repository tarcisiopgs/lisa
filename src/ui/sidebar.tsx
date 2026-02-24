import { basename } from "node:path";
import { Box, Text } from "ink";

interface SidebarProps {
	provider: string;
	source: string;
	cwd: string;
}

export function Sidebar({ provider, source, cwd }: SidebarProps) {
	const dir = basename(cwd);

	return (
		<Box
			flexDirection="column"
			width={28}
			borderStyle="single"
			borderColor="yellow"
			paddingX={1}
			paddingY={0}
		>
			{/* Logo */}
			<Box flexDirection="column" marginBottom={1}>
				<Text color="yellow">{"╔══════════════════════╗"}</Text>
				<Text color="yellow">
					{"║"}
					<Text color="white" bold>
						{"    L I S A  v 2      "}
					</Text>
					<Text color="yellow">{"║"}</Text>
				</Text>
				<Text color="yellow">{"╚══════════════════════╝"}</Text>
			</Box>

			{/* Status indicator */}
			<Box marginBottom={1}>
				<Text color="green">{"▶ "}</Text>
				<Text color="green" bold>
					RUNNING
				</Text>
			</Box>

			<Text color="yellow">{"────────────────────────"}</Text>

			{/* Provider */}
			<Box flexDirection="column" marginTop={1}>
				<Text color="white" dimColor>
					PROVIDER
				</Text>
				<Box>
					<Text color="yellow">{"▸ "}</Text>
					<Text color="white" bold>
						{provider.toUpperCase()}
					</Text>
				</Box>
			</Box>

			{/* Source */}
			<Box flexDirection="column" marginTop={1}>
				<Text color="white" dimColor>
					SOURCE
				</Text>
				<Box>
					<Text color="yellow">{"▸ "}</Text>
					<Text color="white" bold>
						{source.toUpperCase()}
					</Text>
				</Box>
			</Box>

			{/* Directory */}
			<Box flexDirection="column" marginTop={1}>
				<Text color="white" dimColor>
					WORKSPACE
				</Text>
				<Box>
					<Text color="yellow">{"▸ "}</Text>
					<Text color="white" bold>
						{dir.length > 18 ? `${dir.slice(0, 15)}…` : dir}
					</Text>
				</Box>
			</Box>

			<Box flexGrow={1} />

			<Text color="yellow">{"────────────────────────"}</Text>
			<Box marginTop={1} flexDirection="column">
				<Text dimColor>{"[Tab]  next column"}</Text>
				<Text dimColor>{"[↑↓]  navigate    "}</Text>
				<Text dimColor>{"[↵]   view detail "}</Text>
				<Text dimColor>{"[q]   quit        "}</Text>
			</Box>
		</Box>
	);
}
