import { beforeEach, describe, expect, it, vi } from "vitest";
import { appendPrAttribution } from "./github.js";

const mockExeca = vi.fn();

vi.mock("execa", () => ({
	execa: (...args: unknown[]) => mockExeca(...args),
}));

describe("appendPrAttribution", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("deletes provider attribution comments before updating PR body", async () => {
		const comments = [
			{ id: 101, body: "🤖 Generated with [Claude Code](https://claude.ai/code)\n\nCo-Authored-By: Claude <noreply@anthropic.com>" },
			{ id: 102, body: "LGTM! Great work." },
		];

		mockExeca.mockImplementation((_cmd: string, args: string[]) => {
			if (args[0] === "api" && args[1]?.includes("/issues/") && args[1]?.endsWith("/comments")) {
				return Promise.resolve({ stdout: JSON.stringify(comments) });
			}
			if (args[0] === "api" && args[1] === "--method") {
				return Promise.resolve({ stdout: "" });
			}
			if (args[0] === "pr" && args[1] === "view") {
				return Promise.resolve({ stdout: JSON.stringify({ body: "## Summary\n- Added feature" }) });
			}
			if (args[0] === "pr" && args[1] === "edit") {
				return Promise.resolve({ stdout: "" });
			}
			return Promise.resolve({ stdout: "" });
		});

		await appendPrAttribution("https://github.com/owner/repo/pull/42", "claude");

		// Should have fetched comments
		const listCall = mockExeca.mock.calls.find(
			(call) => call[0] === "gh" && call[1]?.[0] === "api" && call[1]?.[1]?.endsWith("/comments"),
		);
		expect(listCall).toBeDefined();

		// Should have deleted the provider comment (id 101)
		const deleteCall = mockExeca.mock.calls.find(
			(call) =>
				call[0] === "gh" &&
				call[1]?.[0] === "api" &&
				call[1]?.[1] === "--method" &&
				call[1]?.[2] === "DELETE" &&
				call[1]?.[3]?.includes("/comments/101"),
		);
		expect(deleteCall).toBeDefined();

		// Should NOT have deleted the human comment (id 102)
		const humanDeleteCall = mockExeca.mock.calls.find(
			(call) =>
				call[0] === "gh" &&
				call[1]?.[0] === "api" &&
				call[1]?.[1] === "--method" &&
				call[1]?.[2] === "DELETE" &&
				call[1]?.[3]?.includes("/comments/102"),
		);
		expect(humanDeleteCall).toBeUndefined();
	});

	it("does not delete comments from human contributors", async () => {
		const comments = [
			{ id: 200, body: "Looks good to me! Nice implementation." },
			{ id: 201, body: "Can you add more tests?" },
		];

		mockExeca.mockImplementation((_cmd: string, args: string[]) => {
			if (args[0] === "api" && args[1]?.includes("/issues/") && args[1]?.endsWith("/comments")) {
				return Promise.resolve({ stdout: JSON.stringify(comments) });
			}
			if (args[0] === "pr" && args[1] === "view") {
				return Promise.resolve({ stdout: JSON.stringify({ body: "## Summary" }) });
			}
			if (args[0] === "pr" && args[1] === "edit") {
				return Promise.resolve({ stdout: "" });
			}
			return Promise.resolve({ stdout: "" });
		});

		await appendPrAttribution("https://github.com/owner/repo/pull/10", "gemini");

		const deleteCalls = mockExeca.mock.calls.filter(
			(call) =>
				call[0] === "gh" &&
				call[1]?.[0] === "api" &&
				call[1]?.[1] === "--method" &&
				call[1]?.[2] === "DELETE",
		);
		expect(deleteCalls).toHaveLength(0);
	});

	it("is non-fatal when comment listing fails", async () => {
		mockExeca.mockImplementation((_cmd: string, args: string[]) => {
			if (args[0] === "api") {
				return Promise.reject(new Error("API error"));
			}
			if (args[0] === "pr" && args[1] === "view") {
				return Promise.resolve({ stdout: JSON.stringify({ body: "## Summary" }) });
			}
			if (args[0] === "pr" && args[1] === "edit") {
				return Promise.resolve({ stdout: "" });
			}
			return Promise.resolve({ stdout: "" });
		});

		// Should not throw
		await expect(
			appendPrAttribution("https://github.com/owner/repo/pull/5", "claude"),
		).resolves.toBeUndefined();
	});

	it("is non-fatal when individual comment deletion fails", async () => {
		const comments = [
			{ id: 300, body: "🤖 Generated with Gemini CLI" },
		];

		mockExeca.mockImplementation((_cmd: string, args: string[]) => {
			if (args[0] === "api" && args[1]?.includes("/issues/") && args[1]?.endsWith("/comments")) {
				return Promise.resolve({ stdout: JSON.stringify(comments) });
			}
			if (args[0] === "api" && args[1] === "--method") {
				return Promise.reject(new Error("Delete failed"));
			}
			if (args[0] === "pr" && args[1] === "view") {
				return Promise.resolve({ stdout: JSON.stringify({ body: "## Summary" }) });
			}
			if (args[0] === "pr" && args[1] === "edit") {
				return Promise.resolve({ stdout: "" });
			}
			return Promise.resolve({ stdout: "" });
		});

		// Should not throw even if deletion fails
		await expect(
			appendPrAttribution("https://github.com/owner/repo/pull/7", "gemini"),
		).resolves.toBeUndefined();
	});

	it("skips comment deletion when PR URL does not match expected format", async () => {
		mockExeca.mockImplementation((_cmd: string, args: string[]) => {
			if (args[0] === "pr" && args[1] === "view") {
				return Promise.resolve({ stdout: JSON.stringify({ body: "## Summary" }) });
			}
			if (args[0] === "pr" && args[1] === "edit") {
				return Promise.resolve({ stdout: "" });
			}
			return Promise.resolve({ stdout: "" });
		});

		await appendPrAttribution("not-a-valid-url", "claude");

		const apiCalls = mockExeca.mock.calls.filter(
			(call) => call[0] === "gh" && call[1]?.[0] === "api",
		);
		expect(apiCalls).toHaveLength(0);
	});

	it("appends lisa attribution to PR body", async () => {
		mockExeca.mockImplementation((_cmd: string, args: string[]) => {
			if (args[0] === "api") {
				return Promise.resolve({ stdout: JSON.stringify([]) });
			}
			if (args[0] === "pr" && args[1] === "view") {
				return Promise.resolve({ stdout: JSON.stringify({ body: "## Summary\n- Feature" }) });
			}
			if (args[0] === "pr" && args[1] === "edit") {
				return Promise.resolve({ stdout: "" });
			}
			return Promise.resolve({ stdout: "" });
		});

		await appendPrAttribution("https://github.com/owner/repo/pull/20", "claude");

		const editCall = mockExeca.mock.calls.find(
			(call) => call[0] === "gh" && call[1]?.[0] === "pr" && call[1]?.[1] === "edit",
		);
		expect(editCall).toBeDefined();
		// args: ["pr", "edit", prUrl, "--body", newBody]
		const bodyArg = editCall?.[1]?.[4] as string;
		expect(bodyArg).toContain("lisa");
		expect(bodyArg).toContain("Claude Code");
	});
});
