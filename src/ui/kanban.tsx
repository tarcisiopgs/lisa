import { Box, useApp, useInput } from "ink";
import type { LisaConfig } from "../types/index.js";
import { Board } from "./board.js";
import { Sidebar } from "./sidebar.js";
import { useKanbanState } from "./state.js";

interface KanbanAppProps {
	config: LisaConfig;
}

export function KanbanApp({ config }: KanbanAppProps) {
	const { exit } = useApp();
	const { cards, isEmpty, workComplete } = useKanbanState();

	useInput((input) => {
		if (input === "q") {
			process.emit("SIGINT");
			exit();
		}
	});

	const labels = {
		backlog: config.source_config.pick_from,
		inProgress: config.source_config.in_progress,
		done: config.source_config.done,
	};

	return (
		<Box flexDirection="row" height={process.stdout.rows}>
			<Sidebar provider={config.provider} source={config.source} cwd={process.cwd()} />
			<Board cards={cards} labels={labels} isEmpty={isEmpty} workComplete={workComplete} />
		</Box>
	);
}
