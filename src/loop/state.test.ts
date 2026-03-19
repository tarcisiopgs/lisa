import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { kanbanEmitter } from "../ui/state.js";
import {
	activeProviderPids,
	hasUserQuitFromWatchPrompt,
	isLoopPaused,
	isShuttingDown,
	killProviderForIssue,
	providerPausedSet,
	reconciliationSet,
	setShuttingDown,
	setUserQuitFromWatchPrompt,
	setupEventListeners,
	userKilledSet,
	userSkippedSet,
} from "./state.js";

describe("watch prompt quit state", () => {
	beforeEach(() => {
		setUserQuitFromWatchPrompt(false);
	});

	it("hasUserQuitFromWatchPrompt returns false by default", () => {
		expect(hasUserQuitFromWatchPrompt()).toBe(false);
	});

	it("hasUserQuitFromWatchPrompt returns true after setUserQuitFromWatchPrompt(true)", () => {
		setUserQuitFromWatchPrompt(true);
		expect(hasUserQuitFromWatchPrompt()).toBe(true);
	});

	it("hasUserQuitFromWatchPrompt returns false after setUserQuitFromWatchPrompt(false)", () => {
		setUserQuitFromWatchPrompt(true);
		setUserQuitFromWatchPrompt(false);
		expect(hasUserQuitFromWatchPrompt()).toBe(false);
	});
});

describe("isShuttingDown / setShuttingDown", () => {
	afterEach(() => {
		setShuttingDown(false);
	});

	it("returns false by default", () => {
		expect(isShuttingDown()).toBe(false);
	});

	it("returns true after setShuttingDown(true)", () => {
		setShuttingDown(true);
		expect(isShuttingDown()).toBe(true);
	});
});

describe("isLoopPaused", () => {
	it("returns false by default", () => {
		expect(isLoopPaused()).toBe(false);
	});
});

describe("killProviderForIssue", () => {
	afterEach(() => {
		activeProviderPids.clear();
		providerPausedSet.clear();
	});

	it("does nothing when no PID is tracked for the issue", () => {
		expect(() => killProviderForIssue("ISSUE-NONE")).not.toThrow();
	});

	it("sends SIGTERM to the tracked PID", () => {
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
		activeProviderPids.set("ISSUE-1", 99999);
		killProviderForIssue("ISSUE-1");
		expect(killSpy).toHaveBeenCalledWith(99999, "SIGTERM");
		killSpy.mockRestore();
	});

	it("sends SIGCONT before SIGTERM when provider is paused", () => {
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
		activeProviderPids.set("ISSUE-2", 88888);
		providerPausedSet.add("ISSUE-2");
		killProviderForIssue("ISSUE-2");
		expect(killSpy).toHaveBeenCalledWith(88888, "SIGCONT");
		expect(killSpy).toHaveBeenCalledWith(88888, "SIGTERM");
		expect(providerPausedSet.has("ISSUE-2")).toBe(false);
		killSpy.mockRestore();
	});

	it("handles process.kill errors gracefully", () => {
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
			throw new Error("ESRCH");
		});
		activeProviderPids.set("ISSUE-3", 77777);
		expect(() => killProviderForIssue("ISSUE-3")).not.toThrow();
		killSpy.mockRestore();
	});
});

describe("setupEventListeners", () => {
	beforeEach(() => {
		setupEventListeners();
	});

	afterEach(() => {
		kanbanEmitter.removeAllListeners();
		activeProviderPids.clear();
		providerPausedSet.clear();
		userKilledSet.clear();
		userSkippedSet.clear();
		setShuttingDown(false);
		setUserQuitFromWatchPrompt(false);
	});

	it("pauses loop on loop:pause event", () => {
		kanbanEmitter.emit("loop:pause");
		expect(isLoopPaused()).toBe(true);
		kanbanEmitter.emit("loop:resume");
		expect(isLoopPaused()).toBe(false);
	});

	it("pauses specific provider on loop:pause-provider with issueId", () => {
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
		activeProviderPids.set("ISSUE-1", 11111);
		kanbanEmitter.emit("loop:pause-provider", "ISSUE-1");
		expect(providerPausedSet.has("ISSUE-1")).toBe(true);
		expect(killSpy).toHaveBeenCalledWith(11111, "SIGSTOP");
		killSpy.mockRestore();
	});

	it("pauses all providers on loop:pause-provider without issueId", () => {
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
		activeProviderPids.set("ISSUE-A", 11111);
		activeProviderPids.set("ISSUE-B", 22222);
		kanbanEmitter.emit("loop:pause-provider");
		expect(providerPausedSet.has("ISSUE-A")).toBe(true);
		expect(providerPausedSet.has("ISSUE-B")).toBe(true);
		killSpy.mockRestore();
	});

	it("resumes specific provider on loop:resume-provider with issueId", () => {
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
		activeProviderPids.set("ISSUE-1", 11111);
		providerPausedSet.add("ISSUE-1");
		kanbanEmitter.emit("loop:resume-provider", "ISSUE-1");
		expect(providerPausedSet.has("ISSUE-1")).toBe(false);
		expect(killSpy).toHaveBeenCalledWith(11111, "SIGCONT");
		killSpy.mockRestore();
	});

	it("resumes all providers on loop:resume-provider without issueId", () => {
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
		activeProviderPids.set("ISSUE-A", 11111);
		activeProviderPids.set("ISSUE-B", 22222);
		providerPausedSet.add("ISSUE-A");
		providerPausedSet.add("ISSUE-B");
		kanbanEmitter.emit("loop:resume-provider");
		expect(providerPausedSet.size).toBe(0);
		killSpy.mockRestore();
	});

	it("kills specific provider on loop:kill with issueId", () => {
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
		activeProviderPids.set("ISSUE-1", 11111);
		kanbanEmitter.emit("loop:kill", "ISSUE-1");
		expect(userKilledSet.has("ISSUE-1")).toBe(true);
		killSpy.mockRestore();
	});

	it("kills first active provider on loop:kill without issueId", () => {
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
		activeProviderPids.set("ISSUE-FIRST", 11111);
		kanbanEmitter.emit("loop:kill");
		expect(userKilledSet.has("ISSUE-FIRST")).toBe(true);
		killSpy.mockRestore();
	});

	it("skips specific provider on loop:skip with issueId", () => {
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
		activeProviderPids.set("ISSUE-1", 11111);
		kanbanEmitter.emit("loop:skip", "ISSUE-1");
		expect(userSkippedSet.has("ISSUE-1")).toBe(true);
		killSpy.mockRestore();
	});

	it("skips first active provider on loop:skip without issueId", () => {
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
		activeProviderPids.set("ISSUE-FIRST", 11111);
		kanbanEmitter.emit("loop:skip");
		expect(userSkippedSet.has("ISSUE-FIRST")).toBe(true);
		killSpy.mockRestore();
	});

	it("sets quit state on loop:quit", () => {
		kanbanEmitter.emit("loop:quit");
		expect(hasUserQuitFromWatchPrompt()).toBe(true);
		expect(isShuttingDown()).toBe(true);
	});
});
