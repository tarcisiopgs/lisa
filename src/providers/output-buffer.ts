import { appendFileSync } from "node:fs";
import * as logger from "../output/logger.js";

let logWriteWarned = false;

/**
 * Appends text to the log file, logging a warning on the first failure
 * instead of silently swallowing errors.
 */
export function safeAppendLog(logFile: string, text: string): void {
	try {
		appendFileSync(logFile, text);
	} catch (err) {
		if (!logWriteWarned) {
			logWriteWarned = true;
			logger.warn(
				`Failed to write to log file ${logFile}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
}

/**
 * Escapes a file path for safe use inside single-quoted shell strings.
 * Handles paths containing single quotes by breaking out of the quote,
 * inserting an escaped quote, and resuming the quoted string.
 * Rejects paths containing control characters for defense-in-depth.
 */
export function escapeShellPath(filePath: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control char check
	if (/[\x00-\x1f\x7f]/.test(filePath)) {
		throw new Error(`Path contains control characters: ${filePath}`);
	}
	return filePath.replace(/'/g, "'\\''");
}

/**
 * Capped output buffer that keeps only the most recent data to prevent
 * unbounded memory growth during long-running provider sessions.
 *
 * Full output is still streamed to the log file on disk — this buffer
 * only caps what is kept in memory for RunResult.output.
 *
 * Evicts oldest chunks incrementally to avoid O(n) memory spikes
 * from joining all chunks before trimming.
 */
export class OutputBuffer {
	private chunks: string[] = [];
	private totalLength = 0;
	private readonly maxBytes: number;

	constructor(maxBytes = 10 * 1024 * 1024) {
		// Default: 10 MB cap
		this.maxBytes = maxBytes;
	}

	push(text: string): void {
		this.chunks.push(text);
		this.totalLength += text.length;
		// Evict oldest chunks incrementally when over budget
		this.evict();
	}

	toString(): string {
		if (this.chunks.length === 0) return "";
		if (this.chunks.length === 1) return this.chunks[0] as string;
		const result = this.chunks.join("");
		// Compact internal state
		this.chunks = [result];
		return result;
	}

	private evict(): void {
		if (this.totalLength <= this.maxBytes) return;

		// Drop oldest chunks until within budget
		while (this.chunks.length > 1 && this.totalLength > this.maxBytes) {
			const removed = this.chunks.shift();
			if (!removed) break;
			this.totalLength -= removed.length;
		}

		// If a single chunk exceeds the cap, trim from the start
		if (this.totalLength > this.maxBytes && this.chunks.length === 1) {
			const chunk = this.chunks[0] as string;
			const trimmed = chunk.slice(chunk.length - this.maxBytes);
			this.chunks[0] = trimmed;
			this.totalLength = trimmed.length;
		}
	}
}
