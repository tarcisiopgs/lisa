import { execSync, spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOutputMode } from "../output/logger.js";
import { STUCK_MESSAGE, startOverseer } from "../session/overseer.js";
import type { Provider, RunOptions, RunResult } from "../types/index.js";

function findCursorBinary(): string | null {
	for (const bin of ["agent", "cursor-agent"]) {
		try {
			execSync(`${bin} --version`, { stdio: "ignore" });
			return bin;
		} catch {}
	}
	return null;
}

export class CursorProvider implements Provider {
	name = "cursor" as const;

	async isAvailable(): Promise<boolean> {
		return findCursorBinary() !== null;
	}

	async run(prompt: string, opts: RunOptions): Promise<RunResult> {
		const start = Date.now();

		const bin = findCursorBinary();
		if (!bin) {
			return {
				success: false,
				output: "cursor agent (agent / cursor-agent) is not installed or not in PATH",
				duration: Date.now() - start,
			};
		}

		const tmpDir = mkdtempSync(join(tmpdir(), "lisa-"));
		const promptFile = join(tmpDir, "prompt.md");
		writeFileSync(promptFile, prompt, "utf-8");

		try {
			const modelFlag = opts.model ? `--model ${opts.model}` : "";
			const proc = spawn(
				"sh",
				["-c", `${bin} -p "$(cat '${promptFile}')" --output-format text --force ${modelFlag}`],
				{
					cwd: opts.cwd,
					stdio: ["ignore", "pipe", "pipe"],
				},
			);

			const overseer = opts.overseer?.enabled ? startOverseer(proc, opts.cwd, opts.overseer) : null;

			const chunks: string[] = [];

			proc.stdout.on("data", (chunk: Buffer) => {
				const text = chunk.toString();
				if (getOutputMode() !== "tui") process.stdout.write(text);
				chunks.push(text);
				try {
					appendFileSync(opts.logFile, text);
				} catch {}
			});

			proc.stderr.on("data", (chunk: Buffer) => {
				const text = chunk.toString();
				if (getOutputMode() !== "tui") process.stderr.write(text);
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

			if (overseer?.wasKilled()) {
				chunks.push(STUCK_MESSAGE);
			}

			return {
				success: exitCode === 0 && !overseer?.wasKilled(),
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
