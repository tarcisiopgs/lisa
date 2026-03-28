import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ActivityState } from "../types/index.js";

export interface JsonlEntry {
	type: string;
	[key: string]: unknown;
}

const TAIL_BYTES = 128 * 1024;
const DEFAULT_IDLE_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Encodes a workspace path to a Claude project directory name.
 * Strips leading `/`, replaces `/` with `-`, replaces `.` with `-`.
 */
export function encodeProjectPath(workspacePath: string): string {
	return workspacePath.replace(/^\//, "").replace(/\//g, "-").replace(/\./g, "-");
}

/**
 * Reads the last 128KB of a JSONL file and returns the last valid JSON entry
 * that has a `type` field. Returns null for empty/missing/corrupted files.
 */
export function parseLastJsonlEntry(filePath: string): JsonlEntry | null {
	let fd: number;

	try {
		const stat = statSync(filePath);
		if (stat.size === 0) return null;

		fd = openSync(filePath, "r");
	} catch {
		return null;
	}

	try {
		const stat = statSync(filePath);
		const readSize = Math.min(stat.size, TAIL_BYTES);
		const offset = stat.size - readSize;
		const buf = Buffer.alloc(readSize);

		readSync(fd, buf, 0, readSize, offset);

		const content = buf.toString("utf8");
		const lines = content.split("\n");

		// Iterate from end to find last valid JSON line with a type field
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i]?.trim();
			if (!line) continue;

			try {
				const parsed = JSON.parse(line) as unknown;
				if (
					parsed !== null &&
					typeof parsed === "object" &&
					"type" in parsed &&
					typeof (parsed as Record<string, unknown>).type === "string"
				) {
					return parsed as JsonlEntry;
				}
			} catch {
				// Not valid JSON, skip
			}
		}

		return null;
	} finally {
		closeSync(fd);
	}
}

/**
 * Maps a JSONL entry type and timestamp to an ActivityState.
 * Stale entries (older than idleThresholdMs) are mapped to "idle" for
 * active/ready states.
 */
export function mapEntryToActivity(
	entryType: string,
	entryTimestamp: number,
	idleThresholdMs: number = DEFAULT_IDLE_THRESHOLD_MS,
): ActivityState {
	const isStale = Date.now() - entryTimestamp > idleThresholdMs;

	switch (entryType) {
		case "user":
		case "tool_use":
		case "progress":
			return isStale ? "idle" : "active";

		case "assistant":
		case "system":
		case "summary":
		case "result":
			return isStale ? "idle" : "ready";

		case "permission_request":
			return "waiting_input";

		case "error":
			return "blocked";

		default:
			return "unknown";
	}
}

/**
 * Detects Claude Code activity for a given workspace path by reading the latest
 * JSONL session file from ~/.claude/projects/<encoded-path>/.
 * Returns "unknown" on any failure.
 */
export function detectClaudeActivity(workspacePath: string): ActivityState {
	try {
		const encoded = encodeProjectPath(workspacePath);
		const projectDir = join(homedir(), ".claude", "projects", encoded);

		let entries: string[];
		try {
			entries = readdirSync(projectDir);
		} catch {
			return "unknown";
		}

		const jsonlFiles = entries
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => {
				const fullPath = join(projectDir, f);
				try {
					const stat = statSync(fullPath);
					return { path: fullPath, mtime: stat.mtimeMs };
				} catch {
					return null;
				}
			})
			.filter((f): f is { path: string; mtime: number } => f !== null)
			.sort((a, b) => b.mtime - a.mtime);

		if (jsonlFiles.length === 0) return "unknown";

		const latest = jsonlFiles[0];
		if (!latest) return "unknown";

		const entry = parseLastJsonlEntry(latest.path);
		if (!entry) return "unknown";

		return mapEntryToActivity(entry.type, latest.mtime);
	} catch {
		return "unknown";
	}
}
