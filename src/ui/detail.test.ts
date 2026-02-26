import { exec as mockExec } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
