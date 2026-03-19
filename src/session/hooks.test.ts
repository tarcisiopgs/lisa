import { describe, expect, it, vi } from "vitest";
import { buildHookEnv, executeHook, runHook } from "./hooks.js";

vi.mock("../output/logger.js", () => ({
	log: vi.fn(),
	error: vi.fn(),
	warn: vi.fn(),
	ok: vi.fn(),
}));

describe("runHook", () => {
	it("returns success=true for a command that exits 0", async () => {
		const result = await runHook("before_run", "echo hello", process.cwd());
		expect(result.success).toBe(true);
		expect(result.output).toContain("hello");
	});

	it("returns success=false for a command that exits non-zero", async () => {
		const result = await runHook("before_run", "exit 1", process.cwd());
		expect(result.success).toBe(false);
	});

	it("injects environment variables", async () => {
		const result = await runHook("before_run", "echo $LISA_ISSUE_ID", process.cwd(), {
			LISA_ISSUE_ID: "TEST-123",
		});
		expect(result.success).toBe(true);
		expect(result.output).toContain("TEST-123");
	});

	it("runs in the specified working directory", async () => {
		const result = await runHook("before_run", "pwd", "/tmp");
		expect(result.success).toBe(true);
		// /tmp may resolve to /private/tmp on macOS
		expect(result.output.trim()).toMatch(/\/tmp$/);
	});

	it("returns failure with timeout message when hook exceeds timeout", async () => {
		const result = await runHook("before_run", "sleep 10", process.cwd(), {}, 200);
		expect(result.success).toBe(false);
		expect(result.output).toContain("timed out");
	}, 15_000);
});

describe("executeHook", () => {
	it("returns true when hooks config is undefined", async () => {
		const result = await executeHook("before_run", undefined, process.cwd(), {});
		expect(result).toBe(true);
	});

	it("returns true when specific hook is not configured", async () => {
		const result = await executeHook("before_run", { after_run: "echo hi" }, process.cwd(), {});
		expect(result).toBe(true);
	});

	it("returns true when critical hook succeeds", async () => {
		const result = await executeHook("before_run", { before_run: "true" }, process.cwd(), {});
		expect(result).toBe(true);
	});

	it("returns false when critical hook fails", async () => {
		const result = await executeHook("before_run", { before_run: "false" }, process.cwd(), {});
		expect(result).toBe(false);
	});

	it("returns true when non-critical hook fails (after_run)", async () => {
		const result = await executeHook("after_run", { after_run: "false" }, process.cwd(), {});
		expect(result).toBe(true);
	});

	it("returns true when non-critical hook fails (before_remove)", async () => {
		const result = await executeHook(
			"before_remove",
			{ before_remove: "false" },
			process.cwd(),
			{},
		);
		expect(result).toBe(true);
	});
});

describe("buildHookEnv", () => {
	it("builds correct environment variables", () => {
		const env = buildHookEnv("ISSUE-1", "Fix bug", "feat/fix", "/workspace/tree");
		expect(env).toEqual({
			LISA_ISSUE_ID: "ISSUE-1",
			LISA_ISSUE_TITLE: "Fix bug",
			LISA_BRANCH: "feat/fix",
			LISA_WORKSPACE: "/workspace/tree",
		});
	});
});
