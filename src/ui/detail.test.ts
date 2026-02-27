import { exec as mockExec } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { statusLabel } from "./detail.js";
import type { KanbanCard } from "./state.js";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		exec: vi.fn((_command: string, callback: (error: Error | null) => void) => {
			callback(null);
		}),
	};
});

describe("openUrl", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("calls open command on macOS", async () => {
		const originalPlatform = process.platform;
		Object.defineProperty(process, "platform", { value: "darwin" });

		const { openUrl } = await import("./detail.js");
		openUrl("https://example.com/pr/123");

		expect(mockExec).toHaveBeenCalledWith(
			'open "https://example.com/pr/123"',
			expect.any(Function),
		);

		Object.defineProperty(process, "platform", { value: originalPlatform });
	});

	it("calls xdg-open command on Linux", async () => {
		const originalPlatform = process.platform;
		Object.defineProperty(process, "platform", { value: "linux" });

		const { openUrl } = await import("./detail.js");
		openUrl("https://example.com/pr/123");

		expect(mockExec).toHaveBeenCalledWith(
			'xdg-open "https://example.com/pr/123"',
			expect.any(Function),
		);

		Object.defineProperty(process, "platform", { value: originalPlatform });
	});

	it("calls start command on Windows", async () => {
		const originalPlatform = process.platform;
		Object.defineProperty(process, "platform", { value: "win32" });

		const { openUrl } = await import("./detail.js");
		openUrl("https://example.com/pr/123");

		expect(mockExec).toHaveBeenCalledWith(
			'start "" "https://example.com/pr/123"',
			expect.any(Function),
		);

		Object.defineProperty(process, "platform", { value: originalPlatform });
	});

	it("does not call exec on unknown platforms", async () => {
		const originalPlatform = process.platform;
		Object.defineProperty(process, "platform", { value: "freebsd" });

		const { openUrl } = await import("./detail.js");
		openUrl("https://example.com/pr/123");

		expect(mockExec).not.toHaveBeenCalled();

		Object.defineProperty(process, "platform", { value: originalPlatform });
	});
});

describe("statusLabel", () => {
	it("returns MERGED/magenta for done merged card", () => {
		const result = statusLabel("done", false, false, false, true);
		expect(result).toEqual({ text: "MERGED", color: "magenta" });
	});

	it("returns DONE/green for done non-merged card", () => {
		const result = statusLabel("done", false, false, false, false);
		expect(result).toEqual({ text: "DONE", color: "green" });
	});

	it("returns DONE/green for done card with merged undefined", () => {
		const result = statusLabel("done");
		expect(result).toEqual({ text: "DONE", color: "green" });
	});

	it("returns IN PROGRESS/yellow for in_progress card", () => {
		const result = statusLabel("in_progress");
		expect(result).toEqual({ text: "IN PROGRESS", color: "yellow" });
	});

	it("returns FAILED/red when hasError is true", () => {
		const result = statusLabel("done", true);
		expect(result).toEqual({ text: "FAILED", color: "red" });
	});

	it("returns KILLED/red when killed is true (takes priority over merged)", () => {
		const result = statusLabel("done", false, true, false, true);
		expect(result).toEqual({ text: "KILLED", color: "red" });
	});

	it("returns SKIPPED/gray when skipped is true", () => {
		const result = statusLabel("done", false, false, true, true);
		expect(result).toEqual({ text: "SKIPPED", color: "gray" });
	});

	it("returns QUEUED/white for backlog card", () => {
		const result = statusLabel("backlog");
		expect(result).toEqual({ text: "QUEUED", color: "white" });
	});
});

describe("KanbanCard prUrl property", () => {
	it("should have prUrl defined in KanbanCard type", () => {
		const card: KanbanCard = {
			id: "TEST-1",
			title: "Test Issue",
			column: "done",
			prUrl: "https://github.com/org/repo/pull/123",
			outputLog: "",
		};

		expect(card.prUrl).toBe("https://github.com/org/repo/pull/123");
	});

	it("should allow optional prUrl in KanbanCard", () => {
		const card: KanbanCard = {
			id: "TEST-1",
			title: "Test Issue",
			column: "in_progress",
			outputLog: "",
		};

		expect(card.prUrl).toBeUndefined();
	});
});
