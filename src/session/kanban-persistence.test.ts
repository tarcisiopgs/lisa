import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCacheDir, getKanbanStatePath } from "../paths.js";
import { kanbanEmitter } from "../ui/state.js";
import { createKanbanPersistence } from "./kanban-persistence.js";

describe("getKanbanStatePath", () => {
	it("returns kanban-state.json inside getCacheDir", () => {
		const result = getKanbanStatePath("/tmp/my-project");
		expect(result).toBe(join(getCacheDir("/tmp/my-project"), "kanban-state.json"));
	});
});

describe("KanbanPersistence.load()", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "lisa-persistence-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns empty array when file does not exist", () => {
		const p = createKanbanPersistence(tmpDir);
		expect(p.load()).toEqual([]);
	});

	it("returns empty array and renames corrupted file to .bak", () => {
		const p = createKanbanPersistence(tmpDir);
		const path = getKanbanStatePath(tmpDir);
		mkdirSync(getCacheDir(tmpDir), { recursive: true });
		writeFileSync(path, "{ not valid json at all");

		const cards = p.load();
		expect(cards).toEqual([]);
		expect(existsSync(path + ".bak")).toBe(true);
		expect(existsSync(path)).toBe(false);
	});

	it("returns empty array and discards file with unknown version", () => {
		const p = createKanbanPersistence(tmpDir);
		const path = getKanbanStatePath(tmpDir);
		mkdirSync(getCacheDir(tmpDir), { recursive: true });
		writeFileSync(path, JSON.stringify({ version: 99, cards: [], updatedAt: Date.now() }));
		expect(p.load()).toEqual([]);
	});

	it("hydrates done and backlog cards unchanged", () => {
		const p = createKanbanPersistence(tmpDir);
		const path = getKanbanStatePath(tmpDir);
		mkdirSync(getCacheDir(tmpDir), { recursive: true });
		writeFileSync(
			path,
			JSON.stringify({
				version: 1,
				updatedAt: Date.now(),
				cards: [
					{
						id: "A",
						title: "Alpha",
						column: "done",
						prUrls: ["https://github.com/x/y/pull/1"],
						outputLogTail: ["line1"],
					},
					{ id: "B", title: "Beta", column: "backlog", prUrls: [], outputLogTail: [] },
				],
			}),
		);
		const cards = p.load();
		expect(cards.find((c) => c.id === "A")?.column).toBe("done");
		expect(cards.find((c) => c.id === "B")?.column).toBe("backlog");
	});

	it("promotes in_progress card with prUrls to done", () => {
		const p = createKanbanPersistence(tmpDir);
		const path = getKanbanStatePath(tmpDir);
		mkdirSync(getCacheDir(tmpDir), { recursive: true });
		writeFileSync(
			path,
			JSON.stringify({
				version: 1,
				updatedAt: Date.now(),
				cards: [
					{
						id: "C",
						title: "Gamma",
						column: "in_progress",
						prUrls: ["https://github.com/x/y/pull/5"],
						outputLogTail: [],
					},
				],
			}),
		);
		const cards = p.load();
		expect(cards.find((c) => c.id === "C")?.column).toBe("done");
	});

	it("demotes in_progress card without prUrls to backlog and clears flags and output", () => {
		const p = createKanbanPersistence(tmpDir);
		const path = getKanbanStatePath(tmpDir);
		mkdirSync(getCacheDir(tmpDir), { recursive: true });
		writeFileSync(
			path,
			JSON.stringify({
				version: 1,
				updatedAt: Date.now(),
				cards: [
					{
						id: "D",
						title: "Delta",
						column: "in_progress",
						prUrls: [],
						hasError: true,
						killed: true,
						startedAt: 1000,
						outputLogTail: ["old output"],
					},
				],
			}),
		);
		const cards = p.load();
		const card = cards.find((c) => c.id === "D")!;
		expect(card.column).toBe("backlog");
		expect(card.startedAt).toBeUndefined();
		expect(card.hasError).toBe(false);
		expect(card.killed).toBe(false);
		expect(card.outputLog).toBe("");
	});

	it("reconstructs outputLog from outputLogTail joined by newline", () => {
		const p = createKanbanPersistence(tmpDir);
		const path = getKanbanStatePath(tmpDir);
		mkdirSync(getCacheDir(tmpDir), { recursive: true });
		writeFileSync(
			path,
			JSON.stringify({
				version: 1,
				updatedAt: Date.now(),
				cards: [
					{ id: "E", title: "Eps", column: "done", prUrls: [], outputLogTail: ["a", "b", "c"] },
				],
			}),
		);
		const cards = p.load();
		expect(cards.find((c) => c.id === "E")?.outputLog).toBe("a\nb\nc");
	});

	it("demotes in_progress card without prUrls: resets skipped flag", () => {
		const p = createKanbanPersistence(tmpDir);
		const path = getKanbanStatePath(tmpDir);
		mkdirSync(getCacheDir(tmpDir), { recursive: true });
		writeFileSync(
			path,
			JSON.stringify({
				version: 1,
				updatedAt: Date.now(),
				cards: [
					{
						id: "F",
						title: "Skipped card",
						column: "in_progress",
						prUrls: [],
						skipped: true,
						outputLogTail: [],
					},
				],
			}),
		);
		const cards = p.load();
		const card = cards.find((c) => c.id === "F")!;
		expect(card.column).toBe("backlog");
		expect(card.skipped).toBe(false);
	});
});

describe("KanbanPersistence.start() — event handling", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "lisa-persistence-test-"));
	});

	afterEach(() => {
		// Remove any lingering listeners from persistence instances that weren't stopped
		kanbanEmitter.removeAllListeners();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("upserts card on issue:queued", () => {
		const p = createKanbanPersistence(tmpDir);
		p.start();
		kanbanEmitter.emit("issue:queued", { id: "X1", title: "Fix bug" });
		p.stop();
		const saved = JSON.parse(readFileSync(getKanbanStatePath(tmpDir), "utf-8"));
		expect(saved.cards).toHaveLength(1);
		expect(saved.cards[0]).toMatchObject({ id: "X1", column: "backlog" });
	});

	it("moves card to in_progress on issue:started", () => {
		const p = createKanbanPersistence(tmpDir);
		p.start();
		kanbanEmitter.emit("issue:queued", { id: "X2", title: "Add feature" });
		kanbanEmitter.emit("issue:started", "X2");
		p.stop();
		const saved = JSON.parse(readFileSync(getKanbanStatePath(tmpDir), "utf-8"));
		expect(saved.cards[0].column).toBe("in_progress");
		expect(saved.cards[0].startedAt).toBeDefined();
	});

	it("moves card to done with prUrls on issue:done", () => {
		const p = createKanbanPersistence(tmpDir);
		p.start();
		kanbanEmitter.emit("issue:queued", { id: "X3", title: "Ship it" });
		kanbanEmitter.emit("issue:done", "X3", ["https://github.com/x/y/pull/42"]);
		p.stop();
		const saved = JSON.parse(readFileSync(getKanbanStatePath(tmpDir), "utf-8"));
		expect(saved.cards[0]).toMatchObject({
			column: "done",
			prUrls: ["https://github.com/x/y/pull/42"],
		});
	});

	it("sets merged on issue:merged", () => {
		const p = createKanbanPersistence(tmpDir);
		p.start();
		kanbanEmitter.emit("issue:queued", { id: "X4", title: "Merged" });
		kanbanEmitter.emit("issue:merged", "X4");
		p.stop();
		const saved = JSON.parse(readFileSync(getKanbanStatePath(tmpDir), "utf-8"));
		expect(saved.cards[0].merged).toBe(true);
	});

	it("moves card to backlog with hasError on issue:reverted", () => {
		const p = createKanbanPersistence(tmpDir);
		p.start();
		kanbanEmitter.emit("issue:queued", { id: "X5", title: "Err" });
		kanbanEmitter.emit("issue:started", "X5");
		kanbanEmitter.emit("issue:reverted", "X5");
		p.stop();
		const saved = JSON.parse(readFileSync(getKanbanStatePath(tmpDir), "utf-8"));
		expect(saved.cards[0]).toMatchObject({ column: "backlog", hasError: true });
	});

	it("caps outputLogTail at 100 lines", () => {
		const p = createKanbanPersistence(tmpDir);
		p.start();
		kanbanEmitter.emit("issue:queued", { id: "X6", title: "Big output" });
		for (let i = 0; i < 150; i++) {
			kanbanEmitter.emit("issue:output", "X6", `line${i}\n`);
		}
		p.stop();
		const saved = JSON.parse(readFileSync(getKanbanStatePath(tmpDir), "utf-8"));
		expect(saved.cards[0].outputLogTail.length).toBeLessThanOrEqual(100);
	});

	it("stop() flushes synchronously before debounce fires", () => {
		const p = createKanbanPersistence(tmpDir);
		p.start();
		kanbanEmitter.emit("issue:queued", { id: "X7", title: "Sync flush" });
		// Stop immediately — don't wait for 500ms debounce
		p.stop();
		expect(existsSync(getKanbanStatePath(tmpDir))).toBe(true);
	});

	it("stop() removes event listeners so further events are ignored", () => {
		const p = createKanbanPersistence(tmpDir);
		p.start();
		kanbanEmitter.emit("issue:queued", { id: "X8", title: "Before stop" });
		p.stop();
		// Emit after stop — should not update the file with new data
		kanbanEmitter.emit("issue:queued", { id: "X9", title: "After stop" });
		const saved = JSON.parse(readFileSync(getKanbanStatePath(tmpDir), "utf-8"));
		expect(saved.cards.some((c: { id: string }) => c.id === "X9")).toBe(false);
	});
});
