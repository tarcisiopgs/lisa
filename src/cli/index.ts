import { defineCommand, runMain } from "citty";
import { config } from "./commands/config.js";
import { context } from "./commands/context.js";
import { doctor } from "./commands/doctor.js";
import { feedback } from "./commands/feedback.js";
import { init } from "./commands/init.js";
import { issue } from "./commands/issue.js";
import { plan } from "./commands/plan.js";
import { executeRun, run, runArgs } from "./commands/run.js";
import { sessions } from "./commands/sessions.js";
import { status } from "./commands/status.js";
import { getVersion } from "./detection.js";

const subCommands = { run, plan, config, init, status, sessions, issue, feedback, context, doctor };

// Flags de string consomem o token seguinte, que não pode ser tomado por subcomando
const stringFlags = new Set(
	Object.entries(runArgs).flatMap(([name, def]) =>
		def.type === "string"
			? [`--${name}`, ...("alias" in def && def.alias ? [`-${def.alias}`] : [])]
			: [],
	),
);

/**
 * Retorna o subcomando que o citty despachou para estes argumentos, se houver.
 * O citty chama o `run` do comando raiz mesmo depois de rodar um subcomando,
 * então o raiz precisa saber quando não deve fazer nada.
 */
export function dispatchedSubCommand(rawArgs: string[]): string | undefined {
	for (let i = 0; i < rawArgs.length; i++) {
		const token = rawArgs[i] as string;
		if (token.startsWith("-")) {
			if (!token.includes("=") && stringFlags.has(token)) i++;
			continue;
		}
		return token in subCommands ? token : undefined;
	}
	return undefined;
}

export const main = defineCommand({
	meta: {
		name: "lisa",
		version: getVersion(),
		description:
			"Deterministic autonomous issue resolver — structured AI agent loop for any issue tracker\n\n  Examples:\n    lisa                              Start the agent loop\n    lisa --dry-run                    Preview config without executing\n    lisa --once --issue INT-123       Run a single specific issue\n    lisa -c 3 --watch                 Process 3 in parallel, poll for new\n    lisa init                         Set up a new project\n\n  Docs: https://github.com/tarcisiopgs/lisa\n  Bugs: https://github.com/tarcisiopgs/lisa/issues",
	},
	args: runArgs,
	subCommands,
	async run({ args, rawArgs }) {
		if (dispatchedSubCommand(rawArgs)) return;
		await executeRun(args);
	},
});

export function runCli(): void {
	runMain(main);
}

export { detectPlatformFromRemoteUrl } from "./detection.js";
