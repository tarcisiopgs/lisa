import { defineCommand, runCommand } from "citty";
import { beforeEach, describe, expect, it, vi } from "vitest";

const executeRun = vi.fn();
const statusRun = vi.fn();

vi.mock("./commands/run.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("./commands/run.js")>();
	return {
		...original,
		executeRun,
		run: defineCommand({
			meta: { name: "run" },
			args: original.runArgs,
			async run({ args }) {
				await executeRun(args);
			},
		}),
	};
});

vi.mock("./commands/status.js", () => ({
	status: defineCommand({ meta: { name: "status" }, run: statusRun }),
}));

const { main } = await import("./index.js");

describe("root command dispatch", () => {
	beforeEach(() => {
		executeRun.mockReset();
		statusRun.mockReset();
	});

	it("does not start the loop after a subcommand ran", async () => {
		await runCommand(main, { rawArgs: ["status"] });

		expect(statusRun).toHaveBeenCalledTimes(1);
		expect(executeRun).not.toHaveBeenCalled();
	});

	it("runs the loop exactly once for `lisa run`", async () => {
		await runCommand(main, { rawArgs: ["run", "--once", "--dry-run"] });

		expect(executeRun).toHaveBeenCalledTimes(1);
	});

	it("runs the loop for bare `lisa`", async () => {
		await runCommand(main, { rawArgs: [] });

		expect(executeRun).toHaveBeenCalledTimes(1);
	});

	it("runs the loop for flags without a subcommand", async () => {
		await runCommand(main, { rawArgs: ["--once"] });

		expect(executeRun).toHaveBeenCalledTimes(1);
	});

	it("runs the loop when a string flag value looks like a subcommand name", async () => {
		await runCommand(main, { rawArgs: ["--issue", "status"] });

		expect(executeRun).toHaveBeenCalledTimes(1);
	});
});
