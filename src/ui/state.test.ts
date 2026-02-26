import { afterEach, describe, expect, it, vi } from "vitest";
import { notify } from "../output/terminal.js";
import { kanbanEmitter, registerBellListeners } from "./state.js";

vi.mock("../output/terminal.js", () => ({
	notify: vi.fn(),
}));

const notifyMock = notify as ReturnType<typeof vi.fn>;

describe("registerBellListeners", () => {
	afterEach(() => {
		kanbanEmitter.removeAllListeners();
		notifyMock.mockClear();
	});

	it("calls notify(1) when issue:done fires and bell is enabled", () => {
		const cleanup = registerBellListeners(true);
		kanbanEmitter.emit("issue:done", "INT-123", "http://pr.url");
		expect(notifyMock).toHaveBeenCalledTimes(1);
		expect(notifyMock).toHaveBeenCalledWith(1);
		cleanup();
	});

	it("calls notify(2) when issue:reverted fires and bell is enabled", () => {
		const cleanup = registerBellListeners(true);
		kanbanEmitter.emit("issue:reverted", "INT-123");
		expect(notifyMock).toHaveBeenCalledTimes(1);
		expect(notifyMock).toHaveBeenCalledWith(2);
		cleanup();
	});

	it("calls notify(1) when work:complete fires and bell is enabled", () => {
		const cleanup = registerBellListeners(true);
		kanbanEmitter.emit("work:complete", { total: 1, duration: 100 });
		expect(notifyMock).toHaveBeenCalledTimes(1);
		expect(notifyMock).toHaveBeenCalledWith(1);
		cleanup();
	});

	it("does not call notify when bell is disabled", () => {
		const cleanup = registerBellListeners(false);
		kanbanEmitter.emit("issue:done", "INT-123", "http://pr.url");
		kanbanEmitter.emit("issue:reverted", "INT-123");
		kanbanEmitter.emit("work:complete", { total: 1, duration: 100 });
		expect(notifyMock).not.toHaveBeenCalled();
		cleanup();
	});

	it("cleanup removes all bell listeners", () => {
		const cleanup = registerBellListeners(true);
		cleanup();
		kanbanEmitter.emit("issue:done", "INT-123", "http://pr.url");
		kanbanEmitter.emit("issue:reverted", "INT-123");
		kanbanEmitter.emit("work:complete", { total: 1, duration: 100 });
		expect(notifyMock).not.toHaveBeenCalled();
	});
});
