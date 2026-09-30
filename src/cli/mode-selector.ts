import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as clack from "@clack/prompts";
import { getLisaHome } from "../paths.js";

export type LisaMode = "autonomous" | "workspace";

const MODES: readonly LisaMode[] = ["autonomous", "workspace"];

export interface SelectorContext {
	rawArgs: string[];
	stdinTTY: boolean;
	stdoutTTY: boolean;
	env: NodeJS.ProcessEnv;
}

/** Modo escolhido por `LISA_MODE`, se válido. */
export function modeFromEnv(env: NodeJS.ProcessEnv): LisaMode | null {
	const value = env.LISA_MODE;
	return MODES.find((m) => m === value) ?? null;
}

/**
 * O seletor só aparece para `lisa` sem argumentos num terminal interativo de verdade,
 * fora de CI e sem `LISA_MODE` definido. Qualquer outro uso mantém o comportamento autônomo.
 */
export function shouldShowSelector(ctx: SelectorContext): boolean {
	return (
		ctx.rawArgs.length === 0 &&
		ctx.stdinTTY &&
		ctx.stdoutTTY &&
		!ctx.env.CI &&
		modeFromEnv(ctx.env) === null
	);
}

function preferencesPath(home: string): string {
	return join(home, "preferences.json");
}

export function readLastMode(home = getLisaHome()): LisaMode | null {
	const path = preferencesPath(home);
	if (!existsSync(path)) return null;
	try {
		const data = JSON.parse(readFileSync(path, "utf-8")) as { lastMode?: string };
		return MODES.find((m) => m === data.lastMode) ?? null;
	} catch {
		return null;
	}
}

export function writeLastMode(mode: LisaMode, home = getLisaHome()): void {
	try {
		mkdirSync(home, { recursive: true });
		writeFileSync(preferencesPath(home), `${JSON.stringify({ lastMode: mode }, null, 2)}\n`);
	} catch {
		// Preferência de conveniência: falhar ao gravar não impede o uso
	}
}

/** Pergunta o modo; `null` quando o usuário cancela. */
export async function selectMode(): Promise<LisaMode | null> {
	const choice = await clack.select<LisaMode>({
		message: "How do you want to work?",
		initialValue: readLastMode() ?? "autonomous",
		options: [
			{ value: "autonomous", label: "Autonomous", hint: "issues in, pull requests out" },
			{
				value: "workspace",
				label: "Workspace",
				hint: "projects, worktrees and interactive agents",
			},
		],
	});
	if (clack.isCancel(choice)) return null;
	writeLastMode(choice);
	return choice;
}
