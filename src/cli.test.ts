import { describe, expect, it } from "vitest";
import { detectPlatformFromRemoteUrl } from "./cli.js";

describe("detectPlatformFromRemoteUrl", () => {
	it("detects GitHub SSH remote", () => {
		expect(detectPlatformFromRemoteUrl("git@github.com:org/repo.git")).toBe("cli");
	});

	it("detects GitHub HTTPS remote", () => {
		expect(detectPlatformFromRemoteUrl("https://github.com/org/repo.git")).toBe("cli");
	});

	it("detects GitLab SSH remote", () => {
		expect(detectPlatformFromRemoteUrl("git@gitlab.com:org/repo.git")).toBe("gitlab");
	});

	it("detects GitLab HTTPS remote", () => {
		expect(detectPlatformFromRemoteUrl("https://gitlab.com/org/repo.git")).toBe("gitlab");
	});

	it("detects self-hosted GitLab", () => {
		expect(detectPlatformFromRemoteUrl("https://gitlab.mycompany.com/org/repo.git")).toBe("gitlab");
	});

	it("detects Bitbucket SSH remote", () => {
		expect(detectPlatformFromRemoteUrl("git@bitbucket.org:workspace/repo.git")).toBe("bitbucket");
	});

	it("detects Bitbucket HTTPS remote", () => {
		expect(detectPlatformFromRemoteUrl("https://bitbucket.org/workspace/repo.git")).toBe(
			"bitbucket",
		);
	});

	it("returns null for unknown remote", () => {
		expect(detectPlatformFromRemoteUrl("https://codeberg.org/org/repo.git")).toBeNull();
	});
});
