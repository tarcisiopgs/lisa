import { execSync } from "node:child_process";
import type { Provider, RunOptions, RunResult } from "../types/index.js";
import {
	formatError,
	type ProviderProcessConfig,
	runProviderProcess,
	validateShellArg,
} from "./run-provider.js";

function findCursorBinary(): string | null {
	for (const bin of ["agent", "cursor-agent"]) {
		try {
			execSync(`which ${bin}`, { stdio: "ignore" });
			return bin;
		} catch {
			/* binary not found */
		}
	}
	return null;
}

// Cursor needs its own binary resolution because it searches two candidate names.
// The result is cached via the instance field _bin (set once per CursorProvider instance).

/**
 * Known tool call type keys emitted by Cursor's stream-json format.
 * Maps internal key names to human-readable action labels.
 */
const TOOL_LABELS: Record<string, string> = {
	readToolCall: "Read",
	editToolCall: "Edit",
	writeToolCall: "Write",
	runCommandToolCall: "Run",
	listDirectoryToolCall: "List",
	codebaseSearchToolCall: "Search",
	grepToolCall: "Grep",
	fileSearchToolCall: "Find",
	deleteToolCall: "Delete",
};

/**
 * Formats a single Cursor stream-json NDJSON event into a human-readable line.
 * Returns null for events that should be suppressed (system, user, result).
 */
function formatStreamEvent(event: Record<string, unknown>): string | null {
	const type = event.type as string;

	if (type === "assistant") {
		const message = event.message as { content?: { text?: string }[] } | undefined;
		const text = message?.content?.[0]?.text;
		return text ? `${text}\n` : null;
	}

	if (type === "tool_call") {
		const subtype = event.subtype as string;
		const toolCall = event.tool_call as Record<string, unknown> | undefined;
		if (!toolCall) return null;

		const toolKey = Object.keys(toolCall)[0];
		if (!toolKey) return null;

		const label = TOOL_LABELS[toolKey] ?? toolKey.replace(/ToolCall$/, "");
		const toolData = toolCall[toolKey] as { args?: Record<string, unknown> } | undefined;

		if (subtype === "started") {
			const path = toolData?.args?.path as string | undefined;
			const command = toolData?.args?.command as string | undefined;
			const query = toolData?.args?.query as string | undefined;
			const target = path ?? command ?? query ?? "";
			return `● ${label} ${target}\n`;
		}

		if (subtype === "completed") {
			const result = (toolData as Record<string, unknown>)?.result as
				| Record<string, unknown>
				| undefined;
			if (result?.error) {
				const errMsg =
					typeof result.error === "string"
						? result.error
						: ((result.error as { message?: string })?.message ?? "error");
				return `✗ ${label} — ${errMsg}\n`;
			}
			return null;
		}
	}

	return null;
}

/**
 * Transforms raw Cursor stream-json NDJSON output into human-readable lines.
 * Handles partial lines across chunks using a closure-scoped buffer.
 */
export function createStreamJsonTransform(): (raw: string) => string {
	let buffer = "";

	return (raw: string): string => {
		buffer += raw;
		const lines = buffer.split("\n");
		// Keep incomplete last line in buffer
		buffer = lines.pop() ?? "";

		let output = "";
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const event = JSON.parse(trimmed) as Record<string, unknown>;
				const formatted = formatStreamEvent(event);
				if (formatted) output += formatted;
			} catch {
				// Non-JSON line — pass through as-is
				output += `${trimmed}\n`;
			}
		}
		return output;
	};
}

export class CursorProvider implements Provider {
	name = "cursor" as const;
	private _bin: string | null | undefined = undefined;

	private resolveBin(): string | null {
		if (this._bin === undefined) this._bin = findCursorBinary();
		return this._bin;
	}

	async isAvailable(): Promise<boolean> {
		return this.resolveBin() !== null;
	}

	async run(prompt: string, opts: RunOptions): Promise<RunResult> {
		const bin = this.resolveBin();
		if (!bin) {
			return {
				success: false,
				output: "cursor agent (agent / cursor-agent) is not installed or not in PATH",
				duration: 0,
			};
		}

		try {
			if (opts.model) validateShellArg(opts.model, "model");
			const modelFlag = opts.model ? `--model ${opts.model}` : "";

			const config: ProviderProcessConfig = {
				name: "cursor",
				buildCommand: (promptCatExpr) =>
					`${bin} -p ${promptCatExpr} --output-format stream-json --force ${modelFlag}`,
				logLine: `${bin} -p --output-format stream-json --force ${modelFlag || "(default model)"}`,
				kanbanLine: `$ ${bin} -p --output-format stream-json --force ${modelFlag || "(default model)"} <prompt: ${prompt.length} chars>\n`,
				errorPattern: /^Error /,
				outputTransform: createStreamJsonTransform(),
			};

			return await runProviderProcess(config, prompt, opts);
		} catch (err) {
			return { success: false, output: formatError(err), duration: 0 };
		}
	}
}
