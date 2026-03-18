import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const TSX = join(process.cwd(), "node_modules", ".bin", "tsx");
const CLI = join(process.cwd(), "src", "index.ts");

describe("lisa CLI (E2E)", () => {
	describe("E-01: --help", () => {
		it("exits 0 and prints usage", () => {
			const result = spawnSync(TSX, [CLI, "--help"], { encoding: "utf-8", timeout: 10_000 });
			expect(result.status).toBe(0);
			expect(result.stdout).toMatch(/lisa/i);
		});

		it("exits 0 and prints subcommands", () => {
			const result = spawnSync(TSX, [CLI, "--help"], { encoding: "utf-8", timeout: 10_000 });
			expect(result.status).toBe(0);
			expect(result.stdout).toContain("run");
			expect(result.stdout).toContain("init");
		});
	});

	describe("E-02: run without config", () => {
		let tmpDir: string;

		beforeEach(() => {
			tmpDir = mkdtempSync(join(tmpdir(), "lisa-e2e-"));
		});

		afterEach(() => {
			rmSync(tmpDir, { recursive: true, force: true });
		});

		it("exits 1 with clear message when .lisa/config.yaml is missing", () => {
			const result = spawnSync(TSX, [CLI, "run"], {
				cwd: tmpDir,
				encoding: "utf-8",
				timeout: 10_000,
			});

			expect(result.status).toBe(1);
			expect(result.stderr).toMatch(/lisa init/i);
		});

		it("writes error to stderr, not stdout", () => {
			const result = spawnSync(TSX, [CLI, "run"], {
				cwd: tmpDir,
				encoding: "utf-8",
				timeout: 10_000,
			});

			expect(result.status).toBe(1);
			expect(result.stderr.length).toBeGreaterThan(0);
			expect(result.stdout).not.toMatch(/lisa init/i);
		});
	});

	describe("E-03: --version", () => {
		it("exits 0 and prints version number", () => {
			const result = spawnSync(TSX, [CLI, "--version"], { encoding: "utf-8", timeout: 10_000 });
			expect(result.status).toBe(0);
			expect(result.stdout).toMatch(/\d+\.\d+\.\d+/);
		});
	});

	describe("E-04: unknown flags", () => {
		let tmpDir: string;

		beforeEach(() => {
			tmpDir = mkdtempSync(join(tmpdir(), "lisa-e2e-"));
		});

		afterEach(() => {
			rmSync(tmpDir, { recursive: true, force: true });
		});

		it("exits 1 when run receives unknown flags", () => {
			const result = spawnSync(TSX, [CLI, "run", "--badFlag"], {
				cwd: tmpDir,
				encoding: "utf-8",
				timeout: 10_000,
			});

			expect(result.status).toBe(1);
			expect(result.stderr).toContain("Unknown flag");
		});
	});

	describe("E-05: context subcommand name", () => {
		it("shows correct command name in help", () => {
			const result = spawnSync(TSX, [CLI, "context", "--help"], {
				encoding: "utf-8",
				timeout: 10_000,
			});

			expect(result.status).toBe(0);
			expect(result.stdout).toContain("lisa context");
			expect(result.stdout).not.toMatch(/lisa\s+\//);
		});
	});

	describe("E-06: description", () => {
		it("does not hardcode specific tracker names", () => {
			const result = spawnSync(TSX, [CLI, "--help"], { encoding: "utf-8", timeout: 10_000 });
			expect(result.status).toBe(0);
			expect(result.stdout).not.toContain("Linear/Trello");
		});
	});
});
