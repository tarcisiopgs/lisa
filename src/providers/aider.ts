import { execSync } from "node:child_process";
import { appendFileSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOutputMode } from "../output/logger.js";
import { createErrorLoopDetector, STUCK_MESSAGE, startOverseer } from "../session/overseer.js";
import type { Provider, RunOptions, RunResult } from "../types/index.js";
import { kanbanEmitter } from "../ui/state.js";
import { spawnWithPty, stripAnsi } from "./pty.js";

// Aider reads these env vars to authenticate with LLM providers.
// OAuth-based auth (e.g. Gemini CLI) is not supported — a direct API key is required.
const AIDER_API_KEY_ENV_VARS = [
	"OPENAI_API_KEY",
	"ANTHROPIC_API_KEY",
	"GEMINI_API_KEY",
	"GROQ_API_KEY",
	"OPENROUTER_API_KEY",
	"COHERE_API_KEY",
	"MISTRAL_API_KEY",
	"DEEPSEEK_API_KEY",
	"AZURE_API_KEY",
];

export class AiderProvider implements Provider {
	name = "aider" as const;

	async isAvailable(): Promise<boolean> {
		try {
			execSync("aider --version", { stdio: "ignore" });
			return true;
		} catch {
			return false;
		}
	}

	async run(prompt: string, opts: RunOptions): Promise<RunResult> {
		const start = Date.now();

		// Fail fast if no API key is set — aider would otherwise try to open a browser
		// for OAuth auth, which hangs in non-interactive environments.
		const hasApiKey = AIDER_API_KEY_ENV_VARS.some((v) => process.env[v]);
		if (!hasApiKey) {
			return {
				success: false,
				output: `Aider requires a direct LLM API key. Set one of: ${AIDER_API_KEY_ENV_VARS.join(", ")}`,
				duration: 0,
			};
		}

		const tmpDir = mkdtempSync(join(tmpdir(), "lisa-"));
		const promptFile = join(tmpDir, "prompt.md");
		writeFileSync(promptFile, prompt, "utf-8");

		try {
			const modelFlag = opts.model ? `--model ${opts.model}` : "";
			const command = `aider --message "$(cat '${promptFile}')" --yes-always ${modelFlag}`;
			const { proc, isPty } = spawnWithPty(command, {
				cwd: opts.cwd,
				env: { ...process.env, ...opts.env },
			});

			if (proc.pid) opts.onProcess?.(proc.pid);
			const overseer = opts.overseer?.enabled ? startOverseer(proc, opts.cwd, opts.overseer) : null;
			const errorLoopDetector = createErrorLoopDetector(proc, /^Error /);

			const chunks: string[] = [];

			proc.stdout?.on("data", (chunk: Buffer) => {
				const raw = chunk.toString();
				const text = isPty ? stripAnsi(raw) : raw;
				errorLoopDetector.check(text);
				if (getOutputMode() !== "tui") process.stdout.write(raw);
				if (opts.issueId) {
					kanbanEmitter.emit("issue:output", opts.issueId, raw);
				}
				chunks.push(text);
				try {
					appendFileSync(opts.logFile, text);
				} catch {}
			});

			proc.stderr?.on("data", (chunk: Buffer) => {
				const raw = chunk.toString();
				const text = isPty ? stripAnsi(raw) : raw;
				if (getOutputMode() !== "tui") process.stderr.write(raw);
				try {
					appendFileSync(opts.logFile, text);
				} catch {}
			});

			const exitCode = await new Promise<number>((resolve) => {
				proc.on("close", (code) => {
					overseer?.stop();
					resolve(code ?? 1);
				});
			});

			if (overseer?.wasKilled() || errorLoopDetector.wasKilled()) {
				chunks.push(STUCK_MESSAGE);
			}

			return {
				success: exitCode === 0 && !overseer?.wasKilled() && !errorLoopDetector.wasKilled(),
				output: chunks.join(""),
				duration: Date.now() - start,
			};
		} catch (err) {
			return {
				success: false,
				output: err instanceof Error ? err.message : String(err),
				duration: Date.now() - start,
			};
		} finally {
			try {
				unlinkSync(promptFile);
			} catch {}
		}
	}
}
