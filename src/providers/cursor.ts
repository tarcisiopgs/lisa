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
		} catch {}
	}
	return null;
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
					`${bin} -p ${promptCatExpr} --output-format text --force ${modelFlag}`,
				logLine: `${bin} -p --output-format text --force ${modelFlag || "(default model)"}`,
				kanbanLine: `$ ${bin} -p --output-format text --force ${modelFlag || "(default model)"} <prompt: ${prompt.length} chars>\n`,
				errorPattern: /^Error /,
			};

			return await runProviderProcess(config, prompt, opts);
		} catch (err) {
			return { success: false, output: formatError(err), duration: 0 };
		}
	}
}
