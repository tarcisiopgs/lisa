import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeProjectPath, mapEntryToActivity, parseLastJsonlEntry } from "./activity.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "lisa-activity-test-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("encodeProjectPath", () => {
	it("strips leading slash, replaces slashes and dots with dashes", () => {
		expect(encodeProjectPath("/Users/dev/projects/my-app")).toBe("Users-dev-projects-my-app");
	});

	it("replaces dots with dashes (hidden directories)", () => {
		expect(encodeProjectPath("/Users/dev/.hidden/app")).toBe("Users-dev--hidden-app");
	});
});

describe("parseLastJsonlEntry", () => {
	it("returns last entry from multi-line JSONL file", () => {
		const filePath = join(tmpDir, "session.jsonl");
		writeFileSync(
			filePath,
			[
				JSON.stringify({ type: "user", content: "first" }),
				JSON.stringify({ type: "assistant", content: "second" }),
				JSON.stringify({ type: "tool_use", content: "third" }),
			].join("\n"),
		);

		const result = parseLastJsonlEntry(filePath);
		expect(result).not.toBeNull();
		expect(result?.type).toBe("tool_use");
		expect(result?.content).toBe("third");
	});

	it("returns null for empty file", () => {
		const filePath = join(tmpDir, "empty.jsonl");
		writeFileSync(filePath, "");

		const result = parseLastJsonlEntry(filePath);
		expect(result).toBeNull();
	});

	it("handles file with trailing newlines", () => {
		const filePath = join(tmpDir, "trailing.jsonl");
		writeFileSync(filePath, JSON.stringify({ type: "assistant", content: "hello" }) + "\n\n\n");

		const result = parseLastJsonlEntry(filePath);
		expect(result).not.toBeNull();
		expect(result?.type).toBe("assistant");
	});

	it("returns null for missing file", () => {
		const result = parseLastJsonlEntry(join(tmpDir, "nonexistent.jsonl"));
		expect(result).toBeNull();
	});
});

describe("mapEntryToActivity", () => {
	const recentTimestamp = Date.now() - 1000; // 1 second ago
	const staleTimestamp = Date.now() - 6 * 60 * 1000; // 6 minutes ago

	it("tool_use with recent timestamp → active", () => {
		expect(mapEntryToActivity("tool_use", recentTimestamp)).toBe("active");
	});

	it("user → active", () => {
		expect(mapEntryToActivity("user", recentTimestamp)).toBe("active");
	});

	it("progress → active", () => {
		expect(mapEntryToActivity("progress", recentTimestamp)).toBe("active");
	});

	it("assistant → ready", () => {
		expect(mapEntryToActivity("assistant", recentTimestamp)).toBe("ready");
	});

	it("result → ready", () => {
		expect(mapEntryToActivity("result", recentTimestamp)).toBe("ready");
	});

	it("permission_request → waiting_input", () => {
		expect(mapEntryToActivity("permission_request", recentTimestamp)).toBe("waiting_input");
	});

	it("error → blocked", () => {
		expect(mapEntryToActivity("error", recentTimestamp)).toBe("blocked");
	});

	it("tool_use with timestamp 6min ago → idle", () => {
		expect(mapEntryToActivity("tool_use", staleTimestamp)).toBe("idle");
	});

	it("unknown type → unknown", () => {
		expect(mapEntryToActivity("some_unknown_type", recentTimestamp)).toBe("unknown");
	});
});
