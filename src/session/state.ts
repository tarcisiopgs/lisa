import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { SessionRecord, SessionState } from "../types/index.js";

export function getSessionsDir(workspace: string): string {
	return join(workspace, ".lisa", "sessions");
}

function sanitizeId(issueId: string): string {
	return issueId.replace(/[^a-zA-Z0-9\-_]/g, "_");
}

function sessionFilePath(workspace: string, issueId: string): string {
	return join(getSessionsDir(workspace), `${sanitizeId(issueId)}.json`);
}

export function createSessionRecord(
	workspace: string,
	issueId: string,
	init?: Partial<SessionRecord>,
): SessionRecord {
	const sessionsDir = getSessionsDir(workspace);
	mkdirSync(sessionsDir, { recursive: true });

	const now = new Date().toISOString();
	const record: SessionRecord = {
		issueId,
		state: "spawning",
		createdAt: now,
		updatedAt: now,
		attempts: { ci: 0, review: 0, validation: 0 },
		history: [],
		...init,
	};

	writeFileSync(sessionFilePath(workspace, issueId), JSON.stringify(record, null, "\t"));
	return record;
}

export function loadSessionRecord(workspace: string, issueId: string): SessionRecord | null {
	const filePath = sessionFilePath(workspace, issueId);
	if (!existsSync(filePath)) return null;
	try {
		const raw = readFileSync(filePath, "utf-8");
		return JSON.parse(raw) as SessionRecord;
	} catch {
		return null;
	}
}

export function updateSessionState(
	workspace: string,
	issueId: string,
	newState: SessionState,
	patch?: Partial<Pick<SessionRecord, "branch" | "worktreePath" | "prUrl" | "reviewFingerprint">>,
	incrementAttempt?: keyof SessionRecord["attempts"],
): SessionRecord | null {
	const record = loadSessionRecord(workspace, issueId);
	if (!record) return null;

	const now = new Date().toISOString();
	record.history.push({ from: record.state, to: newState, at: now });
	record.state = newState;
	record.updatedAt = now;

	if (patch) {
		if (patch.branch !== undefined) record.branch = patch.branch;
		if (patch.worktreePath !== undefined) record.worktreePath = patch.worktreePath;
		if (patch.prUrl !== undefined) record.prUrl = patch.prUrl;
		if (patch.reviewFingerprint !== undefined) record.reviewFingerprint = patch.reviewFingerprint;
	}

	if (incrementAttempt) {
		record.attempts[incrementAttempt]++;
	}

	writeFileSync(sessionFilePath(workspace, issueId), JSON.stringify(record, null, "\t"));
	return record;
}

export function listSessionRecords(workspace: string): SessionRecord[] {
	const sessionsDir = getSessionsDir(workspace);
	if (!existsSync(sessionsDir)) return [];

	const files = readdirSync(sessionsDir).filter((f) => f.endsWith(".json"));
	const records: SessionRecord[] = [];
	for (const file of files) {
		try {
			const raw = readFileSync(join(sessionsDir, file), "utf-8");
			records.push(JSON.parse(raw) as SessionRecord);
		} catch {
			// skip corrupted files
		}
	}
	return records;
}

export function removeSessionRecord(workspace: string, issueId: string): void {
	const filePath = sessionFilePath(workspace, issueId);
	try {
		unlinkSync(filePath);
	} catch {
		// best-effort
	}
}
