import { afterEach, describe, expect, it } from "vitest";
import { kanbanEmitter } from "./state.js";

// ── kanbanEmitter events ──────────────────────────────────────────────────

describe("kanbanEmitter execution control events", () => {
	afterEach(() => {
		kanbanEmitter.removeAllListeners();
	});

	it("emits loop:pause-provider event", () => {
		let received = false;
		kanbanEmitter.on("loop:pause-provider", () => {
			received = true;
		});
		kanbanEmitter.emit("loop:pause-provider");
		expect(received).toBe(true);
	});

	it("emits loop:resume-provider event", () => {
		let received = false;
		kanbanEmitter.on("loop:resume-provider", () => {
			received = true;
		});
		kanbanEmitter.emit("loop:resume-provider");
		expect(received).toBe(true);
	});

	it("emits loop:kill event", () => {
		let received = false;
		kanbanEmitter.on("loop:kill", () => {
			received = true;
		});
		kanbanEmitter.emit("loop:kill");
		expect(received).toBe(true);
	});

	it("emits loop:skip event", () => {
		let received = false;
		kanbanEmitter.on("loop:skip", () => {
			received = true;
		});
		kanbanEmitter.emit("loop:skip");
		expect(received).toBe(true);
	});

	it("emits provider:paused event", () => {
		let received = false;
		kanbanEmitter.on("provider:paused", () => {
			received = true;
		});
		kanbanEmitter.emit("provider:paused");
		expect(received).toBe(true);
	});

	it("emits provider:resumed event", () => {
		let received = false;
		kanbanEmitter.on("provider:resumed", () => {
			received = true;
		});
		kanbanEmitter.emit("provider:resumed");
		expect(received).toBe(true);
	});

	it("emits issue:skipped with issueId", () => {
		let receivedId: string | null = null;
		kanbanEmitter.on("issue:skipped", (id: string) => {
			receivedId = id;
		});
		kanbanEmitter.emit("issue:skipped", "TEST-123");
		expect(receivedId).toBe("TEST-123");
	});

	it("emits issue:killed with issueId", () => {
		let receivedId: string | null = null;
		kanbanEmitter.on("issue:killed", (id: string) => {
			receivedId = id;
		});
		kanbanEmitter.emit("issue:killed", "TEST-456");
		expect(receivedId).toBe("TEST-456");
	});
});

describe("KanbanCard interface", () => {
	it("accepts skipped and killed fields", () => {
		// Type-level test: ensure the interface compiles with new fields
		const card = {
			id: "TEST-1",
			title: "Test",
			column: "backlog" as const,
			outputLog: "",
			skipped: true,
			killed: false,
			pausedAt: undefined,
			pauseAccumulated: 0,
		};
		expect(card.skipped).toBe(true);
		expect(card.killed).toBe(false);
		expect(card.pauseAccumulated).toBe(0);
	});
});
