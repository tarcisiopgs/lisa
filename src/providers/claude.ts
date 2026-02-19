import { appendFileSync } from "node:fs";
import { execa } from "execa";
import type { Provider, RunOptions, RunResult } from "../types.js";

interface StreamEvent {
	type: string;
	[key: string]: unknown;
}

export class ClaudeProvider implements Provider {
	name = "claude" as const;

	async isAvailable(): Promise<boolean> {
		try {
			await execa("claude", ["--version"]);
			return true;
		} catch {
			return false;
		}
	}

	async run(prompt: string, opts: RunOptions): Promise<RunResult> {
		const start = Date.now();

		try {
			const proc = execa(
				"claude",
				["--dangerously-skip-permissions", "-p", prompt, "--output-format", "stream-json"],
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

					// Write raw JSON to log file for full traceability
					try { appendFileSync(opts.logFile, `${line}\n`); } catch {}

					try {
						const raw = JSON.parse(line) as StreamEvent;
						const event = raw.type === "stream_event" && raw.event
							? (raw.event as StreamEvent)
							: raw;

						// Show tool usage on terminal
						if (event.type === "content_block_start") {
							const block = event.content_block as Record<string, unknown> | undefined;
							if (block?.type === "tool_use") {
								process.stdout.write(`\n[tool] ${block.name as string}\n`);
							}
						}

						// Stream text to terminal + collect for result
						if (event.type === "content_block_delta") {
							const delta = event.delta as Record<string, unknown> | undefined;
							if (delta?.type === "text_delta") {
								const text = delta.text as string;
								process.stdout.write(text);
								textChunks.push(text);
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
				output: textChunks.join(""),
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
