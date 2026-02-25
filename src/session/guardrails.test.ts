import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getGuardrailsPath } from "../paths.js";
import {
	appendEntry,
	buildGuardrailsSection,
	extractContext,
	extractErrorType,
	guardrailsPath,
	migrateGuardrails,
	readGuardrails,
} from "./guardrails.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "lisa-guardrails-test-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("guardrailsPath", () => {
	it("returns the cache path", () => {
		const path = guardrailsPath("/project");
		expect(path).toBe(getGuardrailsPath("/project"));
		expect(path).toContain("guardrails.md");
		expect(path).not.toContain(".lisa/guardrails.md");
	});
});

describe("migrateGuardrails", () => {
	it("copies legacy .lisa/guardrails.md to cache", () => {
		const legacyDir = join(tmpDir, ".lisa");
		mkdirSync(legacyDir, { recursive: true });
		writeFileSync(join(legacyDir, "guardrails.md"), "# Legacy content");

		migrateGuardrails(tmpDir);

		const cachePath = getGuardrailsPath(tmpDir);
		expect(existsSync(cachePath)).toBe(true);
		expect(readFileSync(cachePath, "utf-8")).toBe("# Legacy content");
	});

	it("does not overwrite existing cache file", () => {
		const legacyDir = join(tmpDir, ".lisa");
		mkdirSync(legacyDir, { recursive: true });
		writeFileSync(join(legacyDir, "guardrails.md"), "# Legacy content");

		const cachePath = getGuardrailsPath(tmpDir);
		mkdirSync(join(cachePath, ".."), { recursive: true });
		writeFileSync(cachePath, "# Already migrated");

		migrateGuardrails(tmpDir);

		expect(readFileSync(cachePath, "utf-8")).toBe("# Already migrated");
	});

	it("does nothing when no legacy file exists", () => {
		migrateGuardrails(tmpDir);
		expect(existsSync(getGuardrailsPath(tmpDir))).toBe(false);
	});
});

describe("readGuardrails", () => {
	it("returns empty string when file does not exist", () => {
		expect(readGuardrails(tmpDir)).toBe("");
	});

	it("returns file content when file exists", () => {
		const cachePath = guardrailsPath(tmpDir);
		mkdirSync(join(cachePath, ".."), { recursive: true });
		writeFileSync(cachePath, "# Guardrails\n\ncontent here");
		expect(readGuardrails(tmpDir)).toBe("# Guardrails\n\ncontent here");
	});

	it("returns empty string for nonexistent directory", () => {
		expect(readGuardrails(join(tmpDir, "nonexistent"))).toBe("");
	});
});

describe("extractContext", () => {
	it("returns last 20 lines of output", () => {
		const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
		const output = lines.join("\n");
		const context = extractContext(output);
		const contextLines = context.split("\n");
		expect(contextLines).toHaveLength(20);
		expect(contextLines[0]).toBe("line 11");
		expect(contextLines[19]).toBe("line 30");
	});

	it("returns all lines when output has fewer than 20 lines", () => {
		const output = "line 1\nline 2\nline 3";
		expect(extractContext(output)).toBe("line 1\nline 2\nline 3");
	});

	it("trims trailing blank lines from output", () => {
		const output = "line 1\nline 2\n  \n  ";
		const context = extractContext(output);
		// After trim, trailing blank lines disappear
		expect(context).toContain("line 1");
		expect(context).toContain("line 2");
	});
});

describe("extractErrorType", () => {
	it("detects rate limit errors", () => {
		expect(extractErrorType("Error 429: Too Many Requests")).toBe("Rate limit / quota exceeded");
		expect(extractErrorType("rate limit exceeded")).toBe("Rate limit / quota exceeded");
		expect(extractErrorType("quota exceeded")).toBe("Rate limit / quota exceeded");
	});

	it("detects timeout errors", () => {
		expect(extractErrorType("operation timed out")).toBe("Timeout");
		expect(extractErrorType("request timeout")).toBe("Timeout");
	});

	it("detects network errors", () => {
		expect(extractErrorType("ETIMEDOUT: connection failed")).toBe("Network error");
		expect(extractErrorType("ECONNREFUSED")).toBe("Network error");
		expect(extractErrorType("ECONNRESET")).toBe("Network error");
		expect(extractErrorType("ENOTFOUND host")).toBe("Network error");
	});

	it("detects exit code errors with code", () => {
		expect(extractErrorType("Process exited with exit code: 1")).toBe("Exit code 1");
		expect(extractErrorType("exit code 2")).toBe("Exit code 2");
	});

	it("detects non-zero exit when no code number", () => {
		expect(extractErrorType("Process exited with error")).toBe("Non-zero exit code");
	});

	it("returns unknown error for unrecognized output", () => {
		expect(extractErrorType("Something went wrong in the implementation")).toBe("Unknown error");
	});

	it("prioritizes rate limit over timeout if both present", () => {
		expect(extractErrorType("rate limit timeout")).toBe("Rate limit / quota exceeded");
	});
});

describe("appendEntry", () => {
	it("creates .lisa directory and guardrails file on first entry", () => {
		appendEntry(tmpDir, {
			issueId: "INT-100",
			date: "2026-02-19",
			provider: "claude",
			errorType: "Exit code 1",
			context: "Error: file not found",
		});

		const path = guardrailsPath(tmpDir);
		expect(existsSync(path)).toBe(true);

		const content = readFileSync(path, "utf-8");
		expect(content).toContain("# Guardrails — Lições aprendidas");
		expect(content).toContain("## Issue INT-100 (2026-02-19)");
		expect(content).toContain("- Provider: claude");
		expect(content).toContain("- Erro: Exit code 1");
		expect(content).toContain("Error: file not found");
	});

	it("appends additional entries to existing file", () => {
		appendEntry(tmpDir, {
			issueId: "INT-100",
			date: "2026-02-19",
			provider: "claude",
			errorType: "Exit code 1",
			context: "first error",
		});

		appendEntry(tmpDir, {
			issueId: "INT-101",
			date: "2026-02-19",
			provider: "gemini",
			errorType: "Timeout",
			context: "second error",
		});

		const content = readFileSync(guardrailsPath(tmpDir), "utf-8");
		expect(content).toContain("## Issue INT-100 (2026-02-19)");
		expect(content).toContain("## Issue INT-101 (2026-02-19)");
		expect(content).toContain("- Provider: claude");
		expect(content).toContain("- Provider: gemini");
	});

	it("preserves the header when appending multiple entries", () => {
		appendEntry(tmpDir, {
			issueId: "INT-100",
			date: "2026-02-19",
			provider: "claude",
			errorType: "Timeout",
			context: "ctx",
		});

		appendEntry(tmpDir, {
			issueId: "INT-101",
			date: "2026-02-19",
			provider: "gemini",
			errorType: "Exit code 1",
			context: "ctx2",
		});

		const content = readFileSync(guardrailsPath(tmpDir), "utf-8");
		const headerCount = (content.match(/# Guardrails — Lições aprendidas/g) ?? []).length;
		expect(headerCount).toBe(1);
	});

	it("rotates entries when MAX_ENTRIES (20) is exceeded", () => {
		for (let i = 1; i <= 21; i++) {
			appendEntry(tmpDir, {
				issueId: `INT-${i}`,
				date: "2026-02-19",
				provider: "claude",
				errorType: "Exit code 1",
				context: `context ${i}`,
			});
		}

		const content = readFileSync(guardrailsPath(tmpDir), "utf-8");
		// Oldest entry (INT-1) should be rotated out
		expect(content).not.toContain("## Issue INT-1 (2026-02-19)");
		// Newest entry (INT-21) should be present
		expect(content).toContain("## Issue INT-21 (2026-02-19)");
		// Entry 2 should now be the oldest remaining
		expect(content).toContain("## Issue INT-2 (2026-02-19)");
	});

	it("keeps exactly MAX_ENTRIES (20) after multiple rotations", () => {
		for (let i = 1; i <= 25; i++) {
			appendEntry(tmpDir, {
				issueId: `INT-${i}`,
				date: "2026-02-19",
				provider: "claude",
				errorType: "Timeout",
				context: `ctx ${i}`,
			});
		}

		const content = readFileSync(guardrailsPath(tmpDir), "utf-8");
		const entryCount = (content.match(/^## Issue INT-/gm) ?? []).length;
		expect(entryCount).toBe(20);
	});

	it("wraps context in a code block", () => {
		appendEntry(tmpDir, {
			issueId: "INT-200",
			date: "2026-02-19",
			provider: "opencode",
			errorType: "Timeout",
			context: "some context output",
		});

		const content = readFileSync(guardrailsPath(tmpDir), "utf-8");
		expect(content).toContain("```\nsome context output\n```");
	});
});

describe("buildGuardrailsSection", () => {
	it("returns empty string when guardrails file does not exist", () => {
		expect(buildGuardrailsSection(tmpDir)).toBe("");
	});

	it("returns formatted section header when guardrails file exists", () => {
		appendEntry(tmpDir, {
			issueId: "INT-100",
			date: "2026-02-19",
			provider: "claude",
			errorType: "Exit code 1",
			context: "some error output",
		});

		const section = buildGuardrailsSection(tmpDir);
		expect(section).toContain("## Guardrails — Avoid these known pitfalls");
		expect(section).toContain("INT-100");
	});

	it("starts with a newline for clean prompt concatenation", () => {
		appendEntry(tmpDir, {
			issueId: "INT-100",
			date: "2026-02-19",
			provider: "claude",
			errorType: "Timeout",
			context: "error",
		});

		const section = buildGuardrailsSection(tmpDir);
		expect(section.startsWith("\n")).toBe(true);
	});

	it("returns empty string for nonexistent directory", () => {
		expect(buildGuardrailsSection(join(tmpDir, "nonexistent"))).toBe("");
	});
});
