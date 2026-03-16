import { afterEach, describe, expect, it, vi } from "vitest";
import { reconciliationSet } from "../loop/state.js";
import type { Issue, Source, SourceConfig } from "../types/index.js";
import { startReconciliation } from "./reconciliation.js";

vi.mock("../output/logger.js", () => ({
	log: vi.fn(),
	error: vi.fn(),
	warn: vi.fn(),
	ok: vi.fn(),
}));

vi.mock("../ui/state.js", () => ({
	kanbanEmitter: {
		on: vi.fn(),
		off: vi.fn(),
		emit: vi.fn(),
	},
}));

vi.mock("../loop/state.js", () => ({
	reconciliationSet: new Set<string>(),
	killProviderForIssue: vi.fn(),
}));

const baseSourceConfig: SourceConfig = {
	scope: "team",
	project: "project",
	label: "ready",
	pick_from: "Todo",
	in_progress: "In Progress",
	done: "Done",
};

function makeSource(issueOverrides?: Partial<Issue> | null): Source {
	return {
		name: "linear",
		fetchNextIssue: vi.fn().mockResolvedValue(null),
		fetchIssueById: vi.fn().mockResolvedValue(
			issueOverrides === null
				? null
				: {
						id: "TEST-1",
						title: "Test",
						description: "",
						url: "",
						status: "In Progress",
						...issueOverrides,
					},
		),
		updateStatus: vi.fn().mockResolvedValue(undefined),
		removeLabel: vi.fn().mockResolvedValue(undefined),
		attachPullRequest: vi.fn().mockResolvedValue(undefined),
		completeIssue: vi.fn().mockResolvedValue(undefined),
		listIssues: vi.fn().mockResolvedValue([]),
	};
}

afterEach(() => {
	reconciliationSet.clear();
});

describe("startReconciliation", () => {
	it("returns no-op handle when disabled", () => {
		const source = makeSource();
		const handle = startReconciliation(source, "TEST-1", { enabled: false }, baseSourceConfig);
		expect(handle.wasReconciled()).toBe(false);
		handle.stop();
	});

	it("detects issue deletion", async () => {
		const source = makeSource(null);
		const handle = startReconciliation(
			source,
			"TEST-1",
			{ enabled: true, check_interval: 0.05 },
			baseSourceConfig,
		);

		await new Promise((r) => setTimeout(r, 150));
		handle.stop();

		expect(handle.wasReconciled()).toBe(true);
		expect(reconciliationSet.has("TEST-1")).toBe(true);
	});

	it("detects status change to done", async () => {
		const source = makeSource({ status: "Done" });
		const handle = startReconciliation(
			source,
			"TEST-1",
			{ enabled: true, check_interval: 0.05 },
			baseSourceConfig,
		);

		await new Promise((r) => setTimeout(r, 150));
		handle.stop();

		expect(handle.wasReconciled()).toBe(true);
	});

	it("does not reconcile when status is still in_progress", async () => {
		const source = makeSource({ status: "In Progress" });
		const handle = startReconciliation(
			source,
			"TEST-1",
			{ enabled: true, check_interval: 0.05 },
			baseSourceConfig,
		);

		await new Promise((r) => setTimeout(r, 150));
		handle.stop();

		expect(handle.wasReconciled()).toBe(false);
	});

	it("stops cleanly", () => {
		const source = makeSource();
		const handle = startReconciliation(
			source,
			"TEST-1",
			{ enabled: true, check_interval: 60 },
			baseSourceConfig,
		);

		handle.stop();
		expect(handle.wasReconciled()).toBe(false);
	});
});
