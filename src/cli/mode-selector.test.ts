import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { modeFromEnv, readLastMode, shouldShowSelector, writeLastMode } from "./mode-selector.js";

const tty = { stdinTTY: true, stdoutTTY: true, env: {} as NodeJS.ProcessEnv };

describe("shouldShowSelector", () => {
	it("shows the selector for bare lisa in an interactive terminal", () => {
		expect(shouldShowSelector({ ...tty, rawArgs: [] })).toBe(true);
	});

	it("skips it when any argument is given", () => {
		expect(shouldShowSelector({ ...tty, rawArgs: ["-c", "3"] })).toBe(false);
	});

	it("skips it when stdout is piped", () => {
		expect(shouldShowSelector({ ...tty, stdoutTTY: false, rawArgs: [] })).toBe(false);
	});

	it("skips it when stdin is not a terminal", () => {
		expect(shouldShowSelector({ ...tty, stdinTTY: false, rawArgs: [] })).toBe(false);
	});

	it("skips it in CI", () => {
		expect(shouldShowSelector({ ...tty, env: { CI: "true" }, rawArgs: [] })).toBe(false);
	});

	it("skips it when LISA_MODE picks the mode", () => {
		expect(shouldShowSelector({ ...tty, env: { LISA_MODE: "workspace" }, rawArgs: [] })).toBe(
			false,
		);
	});
});

describe("modeFromEnv", () => {
	it("reads a valid LISA_MODE", () => {
		expect(modeFromEnv({ LISA_MODE: "workspace" })).toBe("workspace");
		expect(modeFromEnv({ LISA_MODE: "autonomous" })).toBe("autonomous");
	});

	it("ignores unknown values", () => {
		expect(modeFromEnv({ LISA_MODE: "other" })).toBeNull();
	});
});

describe("last mode", () => {
	let dir: string;
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("remembers the last choice", () => {
		dir = mkdtempSync(join(tmpdir(), "lisa-mode-"));
		expect(readLastMode(dir)).toBeNull();
		writeLastMode("workspace", dir);
		expect(readLastMode(dir)).toBe("workspace");
	});
});
