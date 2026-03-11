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
