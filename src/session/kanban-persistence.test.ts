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
