import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CliError } from "../error.js";
import { platformPackage, resolveWorkspaceBinary, runWorkspaceBinary } from "./workspace.js";

describe("platformPackage", () => {
	it("names the package for supported platforms", () => {
		expect(platformPackage("darwin", "arm64")).toBe("@tarcisiopgs/lisa-workspace-darwin-arm64");
		expect(platformPackage("linux", "x64")).toBe("@tarcisiopgs/lisa-workspace-linux-x64");
	});

	it("returns null for unsupported platforms", () => {
		expect(platformPackage("win32", "x64")).toBeNull();
		expect(platformPackage("linux", "ia32")).toBeNull();
	});
});

describe("resolveWorkspaceBinary", () => {
	it("prefers LISA_WORKSPACE_BIN", () => {
		expect(
			resolveWorkspaceBinary({
				platform: "darwin",
				arch: "arm64",
				env: { LISA_WORKSPACE_BIN: "/x/bin" },
			}),
		).toBe("/x/bin");
	});

	it("explains that Windows is not supported", () => {
		expect(() => resolveWorkspaceBinary({ platform: "win32", arch: "x64", env: {} })).toThrow(
			/not supported on Windows/,
		);
	});

	it("names the missing platform package", () => {
		const resolve = () => {
			throw new Error("not found");
		};
		expect(() =>
			resolveWorkspaceBinary({ platform: "linux", arch: "arm64", env: {}, resolve }),
		).toThrow(/@tarcisiopgs\/lisa-workspace-linux-arm64/);
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
