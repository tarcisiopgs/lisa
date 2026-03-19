import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	cleanupManifest,
	cleanupPlanFile,
	extractPrUrlFromOutput,
	readLisaManifest,
	readManifestFile,
	readPlanFile,
} from "./manifest.js";

describe("extractPrUrlFromOutput", () => {
	it("extracts a GitHub PR URL", () => {
		const output = "Created pull request https://github.com/org/repo/pull/30 successfully";
		expect(extractPrUrlFromOutput(output)).toBe("https://github.com/org/repo/pull/30");
	});

	it("extracts a GitLab merge request URL", () => {
		const output =
			"MR created at https://gitlab.company.com/group/project/-/merge_requests/42 done";
		expect(extractPrUrlFromOutput(output)).toBe(
			"https://gitlab.company.com/group/project/-/merge_requests/42",
		);
	});

	it("extracts a Bitbucket pull request URL", () => {
		const output = "PR: https://bitbucket.org/team/repo/pull-requests/15";
		expect(extractPrUrlFromOutput(output)).toBe("https://bitbucket.org/team/repo/pull-requests/15");
	});

	it("returns null when no PR URL is found", () => {
		const output = "No PR was created. Something went wrong.";
		expect(extractPrUrlFromOutput(output)).toBeNull();
	});

	it("returns the first match when multiple PR URLs are present", () => {
		const output = [
			"First: https://github.com/org/repo/pull/10",
			"Second: https://github.com/org/repo/pull/20",
		].join("\n");
		expect(extractPrUrlFromOutput(output)).toBe("https://github.com/org/repo/pull/10");
	});

	it("extracts URL from multiline output with noise", () => {
		const output = [
			"Running tests...",
			"All tests passed.",
			"Pushing to origin...",
			"remote: Create a pull request for 'feat/fix' on GitHub by visiting:",
			"remote:   https://github.com/org/repo/pull/30",
			"Branch pushed.",
		].join("\n");
		expect(extractPrUrlFromOutput(output)).toBe("https://github.com/org/repo/pull/30");
	});

	it("handles http URLs (not just https)", () => {
		const output = "PR at http://github.com/org/repo/pull/5";
		expect(extractPrUrlFromOutput(output)).toBe("http://github.com/org/repo/pull/5");
	});
});

describe("readManifestFile", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "manifest-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns null when file does not exist", () => {
		expect(readManifestFile(join(tmpDir, "nonexistent.json"))).toBeNull();
	});

	it("parses valid manifest JSON", () => {
		const filePath = join(tmpDir, "manifest.json");
		writeFileSync(filePath, JSON.stringify({ branch: "feat/test", prUrl: "https://example.com" }));
		const result = readManifestFile(filePath);
		expect(result).toEqual({ branch: "feat/test", prUrl: "https://example.com" });
	});

	it("returns null for malformed JSON", () => {
		const filePath = join(tmpDir, "manifest.json");
		writeFileSync(filePath, "not valid json{{{");
		expect(readManifestFile(filePath)).toBeNull();
	});
});

describe("readPlanFile", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "plan-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns null when file does not exist", () => {
		expect(readPlanFile(join(tmpDir, "nonexistent.json"))).toBeNull();
	});

	it("parses valid plan JSON", () => {
		const filePath = join(tmpDir, "plan.json");
		const plan = { steps: [{ repoPath: "/app", scope: "frontend", order: 1 }] };
		writeFileSync(filePath, JSON.stringify(plan));
		expect(readPlanFile(filePath)).toEqual(plan);
	});

	it("returns null for malformed JSON", () => {
		const filePath = join(tmpDir, "plan.json");
		writeFileSync(filePath, "broken");
		expect(readPlanFile(filePath)).toBeNull();
	});
});

describe("cleanupPlanFile", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "cleanup-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("removes the plan file", () => {
		const filePath = join(tmpDir, "plan.json");
		writeFileSync(filePath, "{}");
		cleanupPlanFile(filePath);
		expect(existsSync(filePath)).toBe(false);
	});

	it("removes empty parent directory after cleanup", () => {
		const subDir = join(tmpDir, "plans");
		mkdirSync(subDir);
		const filePath = join(subDir, "plan.json");
		writeFileSync(filePath, "{}");
		cleanupPlanFile(filePath);
		expect(existsSync(subDir)).toBe(false);
	});

	it("does not remove parent directory if it still has files", () => {
		const subDir = join(tmpDir, "plans");
		mkdirSync(subDir);
		const filePath = join(subDir, "plan.json");
		writeFileSync(filePath, "{}");
		writeFileSync(join(subDir, "other.json"), "{}");
		cleanupPlanFile(filePath);
		expect(existsSync(subDir)).toBe(true);
	});

	it("does not throw when file does not exist", () => {
		expect(() => cleanupPlanFile(join(tmpDir, "nonexistent.json"))).not.toThrow();
	});
});

describe("readLisaManifest", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "manifest-lisa-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns null when manifest file does not exist", () => {
		expect(readLisaManifest(tmpDir, "ISSUE-1")).toBeNull();
	});

	it("parses valid manifest from issue-specific path", () => {
		const manifestDir = join(tmpDir, ".lisa", "manifests");
		mkdirSync(manifestDir, { recursive: true });
		writeFileSync(join(manifestDir, "ISSUE-1.json"), JSON.stringify({ branch: "feat/test" }));
		const result = readLisaManifest(tmpDir, "ISSUE-1");
		expect(result).toEqual({ branch: "feat/test" });
	});

	it("returns null for malformed manifest JSON", () => {
		const manifestDir = join(tmpDir, ".lisa", "manifests");
		mkdirSync(manifestDir, { recursive: true });
		writeFileSync(join(manifestDir, "ISSUE-2.json"), "not json!");
		expect(readLisaManifest(tmpDir, "ISSUE-2")).toBeNull();
	});

	it("uses default filename when no issueId provided", () => {
		const manifestDir = join(tmpDir, ".lisa", "manifests");
		mkdirSync(manifestDir, { recursive: true });
		writeFileSync(join(manifestDir, "default.json"), JSON.stringify({ branch: "feat/default" }));
		expect(readLisaManifest(tmpDir)).toEqual({ branch: "feat/default" });
	});
});

describe("cleanupManifest", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "cleanup-manifest-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("removes manifest file", () => {
		const manifestDir = join(tmpDir, ".lisa", "manifests");
		mkdirSync(manifestDir, { recursive: true });
		const filePath = join(manifestDir, "ISSUE-1.json");
		writeFileSync(filePath, "{}");
		cleanupManifest(tmpDir, "ISSUE-1");
		expect(existsSync(filePath)).toBe(false);
	});

	it("does not throw when manifest does not exist", () => {
		expect(() => cleanupManifest(tmpDir, "NONEXISTENT")).not.toThrow();
	});
});
