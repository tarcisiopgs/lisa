import { execSync } from "node:child_process";
import type { Provider, RunOptions, RunResult } from "../types/index.js";
import {
	formatError,
	type ProviderProcessConfig,
	runProviderProcess,
	validateShellArg,
} from "./run-provider.js";

export class ClaudeProvider implements Provider {
	name = "claude" as const;
	supportsNativeWorktree = false; // --worktree flag requires a TTY and hangs in non-interactive mode

	async isAvailable(): Promise<boolean> {
		try {
			execSync("claude --version", { stdio: "ignore" });
			return true;
		} catch {
			return false;
		}
	}

	async run(prompt: string, opts: RunOptions): Promise<RunResult> {
		try {
			const flags = ["-p", "--dangerously-skip-permissions"];
			if (opts.model) {
				validateShellArg(opts.model, "model");
				flags.push("--model", opts.model);
			}
			if (opts.providerOptions?.effort) {
				validateShellArg(opts.providerOptions.effort, "effort");
				flags.push("--effort", opts.providerOptions.effort);
			}

			const flagStr = flags.join(" ");

			const config: ProviderProcessConfig = {
				name: "claude",
				buildCommand: (promptCatExpr) => `claude ${flagStr} ${promptCatExpr}`,
				logLine: `claude ${flagStr}`,
				kanbanLine: `$ claude ${flagStr} <prompt: ${prompt.length} chars>\n`,
				errorPattern: /^Error /,
				extraEnv: { CLAUDECODE: undefined },
				// When Lisa itself runs inside an active Claude Code session (CLAUDECODE is set in the
				// parent environment), the script PTY wrapper reads EOF from its closed stdin and
				// forwards ^D to Claude, causing it to exit. Use a plain spawn without PTY instead.
				forceRawSpawn: Boolean(process.env.CLAUDECODE),
			};

			return await runProviderProcess(config, prompt, opts);
		} catch (err) {
			return { success: false, output: formatError(err), duration: 0 };
		}
	}
}
