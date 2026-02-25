import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { Box, Text } from "ink";

interface SidebarProps {
	provider: string;
	source: string;
	cwd: string;
	activeView: "board" | "detail";
	paused?: boolean;
}

export function Sidebar({ provider, source, cwd, activeView, paused = false }: SidebarProps) {
	const dir = basename(cwd).toUpperCase();
	const cwdLabel = existsSync(join(cwd, ".git")) ? "REPOSITORY" : "WORKSPACE";

	return (
		<Box
			flexDirection="column"
			width={28}
			flexShrink={0}
			borderStyle="single"
			borderColor="yellow"
			paddingX={1}
			paddingY={0}
		>
			{/* Logo */}
			<Box flexDirection="column" marginBottom={1}>
				<Text color="yellow">{"╔══════════════════════╗"}</Text>
				<Text color="yellow">
					{"║  "}
					<Text color="white" bold>
						{"L I S A  "}
					</Text>
					<Text color="yellow" bold>
						{"♪"}
					</Text>
					<Text color="white" bold>
						{"          "}
					</Text>
					{"║"}
				</Text>
				<Text color="yellow">{"╚══════════════════════╝"}</Text>
			</Box>

			{/* Status indicator */}
			<Box marginBottom={1}>
				<Text color={paused ? "yellow" : "green"}>{paused ? "⏸ " : "▶ "}</Text>
				<Text color={paused ? "yellow" : "green"} bold>
					{paused ? "PAUSED" : "RUNNING"}
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
					{cwdLabel}
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

			{/* Dynamic legend */}
			{activeView === "board" ? (
				<Box marginTop={1} flexDirection="column">
					<Text dimColor>{"[Tab]  next column"}</Text>
					<Text dimColor>{"[↑↓]  navigate    "}</Text>
					<Text dimColor>{"[↵]   view detail "}</Text>
					<Text dimColor>{paused ? "[p]   resume      " : "[p]   pause       "}</Text>
					<Text dimColor>{"[q]   quit        "}</Text>
				</Box>
			) : (
				<Box marginTop={1} flexDirection="column">
					<Text dimColor>{"[↑↓]  scroll      "}</Text>
					<Text dimColor>{"[Esc] back to board"}</Text>
				</Box>
			)}
		</Box>
	);
}
