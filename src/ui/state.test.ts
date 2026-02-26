import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Issue } from "../types/index.js";
import { kanbanEmitter, useKanbanState } from "./state.js";

// Mock process.stdout.write
const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

describe("useKanbanState bell notifications", () => {
	beforeEach(() => {
		writeSpy.mockClear();
	});

	afterEach(() => {
		// Ensure all listeners are cleaned up after each test
		kanbanEmitter.removeAllListeners();
	});

	it("should emit a single bell when an issue is done and bell is enabled", () => {
		renderHook(() => useKanbanState(true));

		const mockIssue: Issue = { id: "INT-123", title: "Test Issue", description: "", url: "" };
		act(() => {
			kanbanEmitter.emit("issue:queued", mockIssue);
			kanbanEmitter.emit("issue:started", mockIssue.id);
			kanbanEmitter.emit("issue:done", mockIssue.id, "http://pr.url");
		});

		expect(writeSpy).toHaveBeenCalledTimes(1);
		expect(writeSpy).toHaveBeenCalledWith("\x07");
	});

	it("should emit two bells when an issue is reverted (failed) and bell is enabled", () => {
		renderHook(() => useKanbanState(true));

		const mockIssue: Issue = { id: "INT-123", title: "Test Issue", description: "", url: "" };
		act(() => {
			kanbanEmitter.emit("issue:queued", mockIssue);
			kanbanEmitter.emit("issue:started", mockIssue.id);
			kanbanEmitter.emit("issue:reverted", mockIssue.id);
		});

		expect(writeSpy).toHaveBeenCalledTimes(1);
		expect(writeSpy).toHaveBeenCalledWith("\x07\x07");
	});

	it("should emit a single bell when work is complete and bell is enabled", () => {
		renderHook(() => useKanbanState(true));

		act(() => {
			kanbanEmitter.emit("work:complete", { total: 1, duration: 100 });
		});

		expect(writeSpy).toHaveBeenCalledTimes(1);
		expect(writeSpy).toHaveBeenCalledWith("\x07");
	});

	it("should not emit bells when bell is disabled", () => {
		renderHook(() => useKanbanState(false));

		const mockIssue: Issue = { id: "INT-123", title: "Test Issue", description: "", url: "" };
		act(() => {
			kanbanEmitter.emit("issue:queued", mockIssue);
			kanbanEmitter.emit("issue:started", mockIssue.id);
			kanbanEmitter.emit("issue:done", mockIssue.id, "http://pr.url");
			kanbanEmitter.emit("issue:reverted", mockIssue.id);
			kanbanEmitter.emit("work:complete", { total: 1, duration: 100 });
		});

		expect(writeSpy).not.toHaveBeenCalled();
	});
});
