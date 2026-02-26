import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { Box, Text } from "ink";

interface SidebarProps {
	provider: string;
	model: string | null;
	models: string[];
	source: string;
	cwd: string;
	activeView: "board" | "detail";
	paused?: boolean;
	hasInProgress?: boolean;
	hasPrUrl?: boolean;
}

export function Sidebar({
	provider,
	model,
	models,
	source,
	cwd,
	activeView,
	paused = false,
	hasInProgress = false,
	hasPrUrl = false,
}: SidebarProps) {
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
						{model && models.length === 1 ? ` (${model})` : ""}
					</Text>
				</Box>
				{model && models.length > 1 && (
					<Box paddingLeft={2}>
						<Text color="white" dimColor>
							{model}
						</Text>
					</Box>
				)}
			</Box>

			{/* Model Queue */}
			{models.length > 1 && (
				<Box flexDirection="column" marginTop={1}>
					<Text color="white" dimColor>
						MODEL QUEUE
					</Text>
					{models.map((m, i) => (
						<Box key={m} paddingLeft={2}>
							<Text color="white">
								{`${i + 1}. ${m}`}
								{m === model ? <Text color="yellow">{" ← current"}</Text> : ""}
							</Text>
						</Box>
					))}
				</Box>
			)}

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
					<Text dimColor>{"[←→]  columns     "}</Text>
					<Text dimColor>{"[↑↓]  navigate    "}</Text>
					<Text dimColor>{"[↵]   view detail "}</Text>
					<Text dimColor>{paused ? "[p]   resume      " : "[p]   pause       "}</Text>
					{hasInProgress && <Text dimColor>{"[k]   kill issue  "}</Text>}
					{hasInProgress && <Text dimColor>{"[s]   skip issue  "}</Text>}
					<Text dimColor>{"[q]   quit        "}</Text>
				</Box>
			) : (
				<Box marginTop={1} flexDirection="column">
					<Text dimColor>{"[↑↓]  scroll      "}</Text>
					{hasPrUrl && <Text dimColor>{"[o]   open PR    "}</Text>}
					<Text dimColor>{"[Esc] back to board"}</Text>
				</Box>
			)}
		</Box>
	);
}
