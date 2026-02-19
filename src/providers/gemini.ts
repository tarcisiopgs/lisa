import { appendFileSync } from "node:fs";
import { execa } from "execa";
import type { Provider, RunOptions, RunResult } from "../types.js";

interface StreamEvent {
	type: string;
	[key: string]: unknown;
}

export class GeminiProvider implements Provider {
	name = "gemini" as const;

	async isAvailable(): Promise<boolean> {
		try {
			await execa("gemini", ["--version"]);
			return true;
		} catch {
			return false;
		}
	}

	async run(prompt: string, opts: RunOptions): Promise<RunResult> {
		const start = Date.now();

		try {
			const proc = execa(
				"gemini",
				["--yolo", "-p", prompt, "--output-format", "stream-json"],
				{
					cwd: opts.cwd,
					timeout: 30 * 60 * 1000,
					reject: false,
				},
			);

			let buffer = "";
			const textChunks: string[] = [];

			proc.stdout?.on("data", (chunk: Buffer) => {
				buffer += chunk.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";

				for (const line of lines) {
					if (!line.trim()) continue;

					// Write raw JSON to log file
					try { appendFileSync(opts.logFile, `${line}\n`); } catch {}

					try {
						const event = JSON.parse(line) as StreamEvent;

						// Show tool usage on terminal
						if (event.type === "tool_use") {
							process.stdout.write(`\n[tool] ${event.tool_name as string}\n`);
						}

						// Show assistant messages + collect for result
						if (event.type === "message" && event.role === "assistant") {
							const content = event.content as string;
							if (content) {
								process.stdout.write(`${content}\n`);
								textChunks.push(content);
							}
						}
					} catch {
						// Not valid JSON, write raw to terminal
						process.stdout.write(`${line}\n`);
					}
				}
			});

			proc.stderr?.on("data", (chunk: Buffer) => {
				const text = chunk.toString();
				process.stderr.write(text);
				try { appendFileSync(opts.logFile, text); } catch {}
			});

			const result = await proc;

			return {
				success: result.exitCode === 0,
				output: textChunks.join("\n"),
				duration: Date.now() - start,
			};
		} catch (err) {
			return {
				success: false,
				output: err instanceof Error ? err.message : String(err),
				duration: Date.now() - start,
			};
		}
	}
}
