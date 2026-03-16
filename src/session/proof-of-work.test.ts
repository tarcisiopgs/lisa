import { describe, expect, it, vi } from "vitest";
import type { ValidationResult } from "../types/index.js";
import {
	buildValidationRecoveryPrompt,
	formatProofOfWork,
	isProofOfWorkEnabled,
	runValidationCommands,
} from "./proof-of-work.js";

vi.mock("../output/logger.js", () => ({
	log: vi.fn(),
	error: vi.fn(),
	warn: vi.fn(),
	ok: vi.fn(),
}));

describe("runValidationCommands", () => {
	it("runs passing commands and returns success", async () => {
		const results = await runValidationCommands([{ name: "Echo", run: "echo ok" }], process.cwd());
		expect(results).toHaveLength(1);
		expect(results[0]?.success).toBe(true);
		expect(results[0]?.name).toBe("Echo");
		expect(results[0]?.duration).toBeGreaterThan(0);
	});

	it("runs failing commands and returns failure", async () => {
		const results = await runValidationCommands([{ name: "Fail", run: "exit 1" }], process.cwd());
		expect(results).toHaveLength(1);
		expect(results[0]?.success).toBe(false);
	});

	it("runs multiple commands sequentially", async () => {
		const results = await runValidationCommands(
			[
				{ name: "Pass", run: "echo pass" },
				{ name: "Fail", run: "exit 1" },
			],
			process.cwd(),
		);
		expect(results).toHaveLength(2);
		expect(results[0]?.success).toBe(true);
		expect(results[1]?.success).toBe(false);
	});

	it("handles timeout", async () => {
		const results = await runValidationCommands(
			[{ name: "Slow", run: "sleep 10" }],
			process.cwd(),
			200,
		);
		expect(results).toHaveLength(1);
		expect(results[0]?.success).toBe(false);
		expect(results[0]?.output).toContain("timed out");
	}, 10_000);
});

describe("formatProofOfWork", () => {
	it("formats all-passing results", () => {
		const results: ValidationResult[] = [
			{ name: "Tests", success: true, output: "", duration: 12000 },
			{ name: "Lint", success: true, output: "", duration: 3000 },
		];
		const md = formatProofOfWork(results);
		expect(md).toContain("## Proof of Work");
		expect(md).toContain("| Tests | Pass | 12s |");
		expect(md).toContain("| Lint | Pass | 3s |");
		expect(md).not.toContain("<details>");
	});

	it("includes failure details", () => {
		const results: ValidationResult[] = [
			{ name: "Tests", success: true, output: "", duration: 12000 },
			{ name: "Lint", success: false, output: "Error: missing semicolon", duration: 1000 },
		];
		const md = formatProofOfWork(results);
		expect(md).toContain("| Lint | Fail | 1s |");
		expect(md).toContain("<details><summary>Lint output</summary>");
		expect(md).toContain("missing semicolon");
	});
});

describe("buildValidationRecoveryPrompt", () => {
	it("includes issue info and failure details", () => {
		const failures: ValidationResult[] = [
			{
				name: "Lint",
				success: false,
				output: "src/foo.ts: error",
				duration: 1000,
			},
		];
		const prompt = buildValidationRecoveryPrompt(
			{ id: "INT-1", title: "Fix bug", description: "", url: "" },
			failures,
		);
		expect(prompt).toContain("INT-1");
		expect(prompt).toContain("Fix bug");
		expect(prompt).toContain("src/foo.ts: error");
		expect(prompt).toContain("Do NOT create a new branch");
	});
});

describe("isProofOfWorkEnabled", () => {
	it("returns false when config is undefined", () => {
		expect(isProofOfWorkEnabled(undefined)).toBe(false);
	});

	it("returns false when enabled is false", () => {
		expect(isProofOfWorkEnabled({ enabled: false, commands: [{ name: "t", run: "t" }] })).toBe(
			false,
		);
	});

	it("returns false when commands is empty", () => {
		expect(isProofOfWorkEnabled({ enabled: true, commands: [] })).toBe(false);
	});

	it("returns true when enabled and has commands", () => {
		expect(
			isProofOfWorkEnabled({ enabled: true, commands: [{ name: "Test", run: "npm test" }] }),
		).toBe(true);
	});
});
