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
 */
export function escapeShellPath(filePath: string): string {
	return filePath.replace(/'/g, "'\\''");
}

/**
 * Capped output buffer that keeps only the most recent data to prevent
 * unbounded memory growth during long-running provider sessions.
 *
 * Full output is still streamed to the log file on disk — this buffer
 * only caps what is kept in memory for RunResult.output.
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
	}

	toString(): string {
		if (this.totalLength <= this.maxBytes) {
			return this.chunks.join("");
		}
		// Evict oldest chunks until within budget
		const joined = this.chunks.join("");
		const trimmed = joined.slice(joined.length - this.maxBytes);
		// Reset internal state to the trimmed value
		this.chunks = [trimmed];
		this.totalLength = trimmed.length;
		return trimmed;
	}
}
