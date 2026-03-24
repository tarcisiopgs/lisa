import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { Box, Text } from "ink";
import type { UpdateInfo } from "../version.js";
import { formatElapsed } from "./format.js";

export type SidebarMode =
	| "board"
	| "detail"
	| "watching"
	| "watch-prompt"
	| "empty"
	| "idle"
	| "plan-chat"
	| "plan-review";

interface SidebarProps {
	provider: string;
	model: string | null;
	models: string[];
	source: string;
	cwd: string;
	activeView: SidebarMode;
	paused?: boolean;
	hasInProgress?: boolean;
	hasPrUrl?: boolean;
	canMerge?: boolean;
	mergeConfirm?: string | null;
	merging?: string | null;
	updateInfo?: UpdateInfo | null;
	workComplete?: { total: number; duration: number } | null;
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
	canMerge = false,
	mergeConfirm = null,
	merging = null,
	updateInfo = null,
	workComplete = null,
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
				{activeView === "idle" || activeView === "empty" ? (
					<>
						<Text color="gray">{"◇ "}</Text>
						<Text color="gray" bold>
							IDLE
						</Text>
					</>
				) : (
					<>
						<Text color={paused ? "yellow" : "green"}>{paused ? "⏸ " : "▶ "}</Text>
						<Text color={paused ? "yellow" : "green"} bold>
							{paused ? "PAUSED" : "RUNNING"}
						</Text>
					</>
				)}
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

			{/* Model — single model: own dedicated row */}
			{models.length <= 1 && (
				<Box flexDirection="column" marginTop={1}>
					<Text color="white" dimColor>
						MODEL
					</Text>
					<Box>
						<Text color="yellow">{"▸ "}</Text>
						<Text color="white" bold>
							{(() => {
								const m = (model ?? "default").toUpperCase();
								return m.length > 19 ? `${m.slice(0, 18)}…` : m;
							})()}
						</Text>
					</Box>
				</Box>
			)}

			{/* Model Queue — multiple models: bullet marks active */}
			{models.length > 1 && (
				<Box flexDirection="column" marginTop={1}>
					<Text color="white" dimColor>
						MODEL QUEUE
					</Text>
					{models.map((m, i) => (
						<Box key={m} paddingLeft={1} flexDirection="row">
							<Text color={m === model ? "yellow" : "gray"}>
								{m === model ? "● " : `${i + 1}. `}
							</Text>
							<Text color={m === model ? "yellow" : "white"} bold={m === model}>
								{(() => {
									const display = m.toUpperCase();
									return display.length > 19 ? `${display.slice(0, 18)}…` : display;
								})()}
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

			{/* Update notification */}
			{updateInfo && (
				<Box flexDirection="column" marginBottom={1}>
					<Text color="yellow">{"────────────────────────"}</Text>
					<Box marginTop={1} flexDirection="column">
						<Text color="green" bold>
							UPDATE AVAILABLE
						</Text>
						<Text dimColor>
							{updateInfo.currentVersion}
							{" → "}
							<Text color="green">{updateInfo.latestVersion}</Text>
						</Text>
						<Text dimColor>npm i -g @tarcisiopgs/lisa</Text>
					</Box>
				</Box>
			)}

			<Text color="yellow">{"────────────────────────"}</Text>

			{/* Dynamic legend — only shows action shortcuts for the current context */}
			{activeView === "board" && (
				<Box marginTop={1} flexDirection="column">
					{hasInProgress && <Text dimColor>{"[k]  kill"}</Text>}
					<Text dimColor>{"[n]  plan"}</Text>
					<Text dimColor>{"[q]  quit"}</Text>
				</Box>
			)}
			{activeView === "detail" && (
				<Box marginTop={1} flexDirection="column">
					{hasPrUrl && <Text dimColor>{"[o]  open PR"}</Text>}
					{canMerge && !merging && !mergeConfirm && <Text dimColor>{"[m]  merge"}</Text>}
					{merging && <Text color="yellow">{"⏳ merging..."}</Text>}
					{mergeConfirm && <Text color="yellow">{"⚠ CI not passed\n   merge? [y/n]"}</Text>}
					<Text dimColor>{"[Esc] back"}</Text>
				</Box>
			)}
			{activeView === "watching" && (
				<Box marginTop={1} flexDirection="column">
					<Text dimColor>{"[q]  quit"}</Text>
				</Box>
			)}
			{activeView === "watch-prompt" && (
				<Box marginTop={1} flexDirection="column">
					{workComplete && (
						<Text color="green" bold>
							{`${workComplete.total} issue${workComplete.total !== 1 ? "s" : ""} · ${formatElapsed(workComplete.duration)}`}
						</Text>
					)}
					<Text dimColor>{"[w]  watch"}</Text>
					<Text dimColor>{"[q]  quit"}</Text>
				</Box>
			)}
			{activeView === "empty" && (
				<Box marginTop={1} flexDirection="column">
					<Text dimColor>{"[n]  plan"}</Text>
					<Text dimColor>{"[q]  quit"}</Text>
				</Box>
			)}
			{activeView === "idle" && (
				<Box marginTop={1} flexDirection="column">
					<Text dimColor>{"[r]  run"}</Text>
					<Text dimColor>{"[n]  plan"}</Text>
					<Text dimColor>{"[q]  quit"}</Text>
				</Box>
			)}
			{activeView === "plan-chat" && (
				<Box marginTop={1} flexDirection="column">
					<Text dimColor>{"[↵]  send"}</Text>
					<Text dimColor>{"[Esc] cancel"}</Text>
				</Box>
			)}
			{activeView === "plan-review" && (
				<Box marginTop={1} flexDirection="column">
					<Text dimColor>{"[↑↓] navigate"}</Text>
					<Text dimColor>{"[↵]  detail"}</Text>
					<Text dimColor>{"[e]  edit"}</Text>
					<Text dimColor>{"[d]  delete"}</Text>
					<Text dimColor>{"[a]  approve"}</Text>
					<Text dimColor>{"[Esc] cancel"}</Text>
				</Box>
			)}
		</Box>
	);
}
