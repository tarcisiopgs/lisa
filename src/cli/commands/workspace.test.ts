import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CliError } from "../error.js";
import { platformDir, resolveWorkspaceBinary, runWorkspaceBinary } from "./workspace.js";

describe("platformDir", () => {
	it("names the bundled directory for supported platforms", () => {
		expect(platformDir("darwin", "arm64")).toBe("darwin-arm64");
		expect(platformDir("linux", "x64")).toBe("linux-x64");
	});

	it("returns null for unsupported platforms", () => {
		expect(platformDir("win32", "x64")).toBeNull();
		expect(platformDir("linux", "ia32")).toBeNull();
	});
});

describe("resolveWorkspaceBinary", () => {
	let root: string;
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("prefers LISA_WORKSPACE_BIN", () => {
		root = mkdtempSync(join(tmpdir(), "lisa-root-"));
		expect(
			resolveWorkspaceBinary({
				platform: "darwin",
				arch: "arm64",
				env: { LISA_WORKSPACE_BIN: "/x/bin" },
				root,
			}),
		).toBe("/x/bin");
	});

	it("finds the binary bundled for the platform", () => {
		root = mkdtempSync(join(tmpdir(), "lisa-root-"));
		const dir = join(root, "bin", "workspace", "linux-arm64");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "lisa-workspace"), "#!/bin/sh\n");
		expect(resolveWorkspaceBinary({ platform: "linux", arch: "arm64", env: {}, root })).toBe(
			join(dir, "lisa-workspace"),
		);
	});

	it("restores the executable bit if the install lost it", () => {
		root = mkdtempSync(join(tmpdir(), "lisa-root-"));
		const dir = join(root, "bin", "workspace", "darwin-x64");
		mkdirSync(dir, { recursive: true });
		const bin = join(dir, "lisa-workspace");
		writeFileSync(bin, "#!/bin/sh\n");
		chmodSync(bin, 0o644);
		resolveWorkspaceBinary({ platform: "darwin", arch: "x64", env: {}, root });
		expect(statSync(bin).mode & 0o111).not.toBe(0);
	});

	it("explains that Windows is not supported", () => {
		root = mkdtempSync(join(tmpdir(), "lisa-root-"));
		expect(() => resolveWorkspaceBinary({ platform: "win32", arch: "x64", env: {}, root })).toThrow(
			/not supported on Windows/,
		);
	});

	it("names the missing binary when the installation lacks it", () => {
		root = mkdtempSync(join(tmpdir(), "lisa-root-"));
		expect(() => resolveWorkspaceBinary({ platform: "linux", arch: "x64", env: {}, root })).toThrow(
			/linux-x64/,
		);
	});
});

describe("runWorkspaceBinary", () => {
	let dir: string;
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("propagates the binary exit code", () => {
		dir = mkdtempSync(join(tmpdir(), "lisa-ws-"));
		const bin = join(dir, "fake");
		writeFileSync(bin, "#!/bin/sh\nexit 3\n");
		chmodSync(bin, 0o755);
		try {
			runWorkspaceBinary(bin);
			expect.unreachable("should throw");
		} catch (err) {
			expect(err).toBeInstanceOf(CliError);
			expect((err as CliError).exitCode).toBe(3);
		}
	});

	it("returns normally when the binary exits 0", () => {
		dir = mkdtempSync(join(tmpdir(), "lisa-ws-"));
		const bin = join(dir, "ok");
		writeFileSync(bin, "#!/bin/sh\nexit 0\n");
		chmodSync(bin, 0o755);
		expect(() => runWorkspaceBinary(bin)).not.toThrow();
	});
});
