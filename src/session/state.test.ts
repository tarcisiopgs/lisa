import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createSessionRecord,
	listSessionRecords,
	loadSessionRecord,
	removeSessionRecord,
	updateSessionState,
} from "./state.js";

describe("session state", () => {
	let workspace: string;

	beforeEach(() => {
		workspace = mkdtempSync(join(tmpdir(), "lisa-state-test-"));
	});

	afterEach(() => {
		rmSync(workspace, { recursive: true, force: true });
	});

	it("should create and load a session record", () => {
		const record = createSessionRecord(workspace, "ISSUE-1");
		expect(record.issueId).toBe("ISSUE-1");
		expect(record.state).toBe("spawning");
		expect(record.attempts).toEqual({ ci: 0, review: 0, validation: 0 });
		expect(record.history).toEqual([]);

		const loaded = loadSessionRecord(workspace, "ISSUE-1");
		expect(loaded).not.toBeNull();
		expect(loaded?.issueId).toBe("ISSUE-1");
		expect(loaded?.state).toBe("spawning");
	});

	it("should return null for non-existent session", () => {
		const result = loadSessionRecord(workspace, "UNKNOWN-99");
		expect(result).toBeNull();
	});

	it("should update session state with history", () => {
		createSessionRecord(workspace, "ISSUE-2");
		const updated = updateSessionState(workspace, "ISSUE-2", "implementing");
		expect(updated).not.toBeNull();
		expect(updated?.state).toBe("implementing");
		expect(updated?.history).toHaveLength(1);
		const transition = updated?.history.at(0);
		expect(transition?.from).toBe("spawning");
		expect(transition?.to).toBe("implementing");
	});

	it("should update additional fields", () => {
		createSessionRecord(workspace, "ISSUE-3");
		const updated = updateSessionState(workspace, "ISSUE-3", "pr_created", {
			prUrl: "https://github.com/org/repo/pull/42",
		});
		expect(updated?.prUrl).toBe("https://github.com/org/repo/pull/42");

		const loaded = loadSessionRecord(workspace, "ISSUE-3");
		expect(loaded?.prUrl).toBe("https://github.com/org/repo/pull/42");
	});

	it("should list all session records", () => {
		createSessionRecord(workspace, "ISSUE-A");
		createSessionRecord(workspace, "ISSUE-B");
		const records = listSessionRecords(workspace);
		expect(records).toHaveLength(2);
	});

	it("should remove a session record", () => {
		createSessionRecord(workspace, "ISSUE-DEL");
		removeSessionRecord(workspace, "ISSUE-DEL");
		const result = loadSessionRecord(workspace, "ISSUE-DEL");
		expect(result).toBeNull();
	});

	it("should increment attempt counts", () => {
		createSessionRecord(workspace, "ISSUE-CI");
		const updated = updateSessionState(workspace, "ISSUE-CI", "ci_failed", undefined, "ci");
		expect(updated?.attempts.ci).toBe(1);
		expect(updated?.attempts.review).toBe(0);
		expect(updated?.attempts.validation).toBe(0);
	});
});
