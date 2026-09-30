import { defineCommand, runCommand } from "citty";
import { beforeEach, describe, expect, it, vi } from "vitest";

const executeRun = vi.fn();
const statusRun = vi.fn();
const runWorkspace = vi.fn();
const selectMode = vi.fn();
const shouldShowSelector = vi.fn(() => false);

vi.mock("./mode-selector.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("./mode-selector.js")>();
	return { ...original, selectMode, shouldShowSelector };
});

vi.mock("./commands/workspace.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("./commands/workspace.js")>();
	return {
		...original,
		runWorkspace,
		workspace: defineCommand({ meta: { name: "workspace" }, run: runWorkspace }),
	};
});

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
		runWorkspace.mockReset();
		selectMode.mockReset();
		shouldShowSelector.mockReset();
		shouldShowSelector.mockReturnValue(false);
		delete process.env.LISA_MODE;
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

	it("opens the workspace when the selector picks it", async () => {
		shouldShowSelector.mockReturnValue(true);
		selectMode.mockResolvedValue("workspace");
		await runCommand(main, { rawArgs: [] });

		expect(runWorkspace).toHaveBeenCalledTimes(1);
		expect(executeRun).not.toHaveBeenCalled();
	});

	it("runs the loop when the selector picks autonomous", async () => {
		shouldShowSelector.mockReturnValue(true);
		selectMode.mockResolvedValue("autonomous");
		await runCommand(main, { rawArgs: [] });

		expect(executeRun).toHaveBeenCalledTimes(1);
		expect(runWorkspace).not.toHaveBeenCalled();
	});

	it("does nothing when the selector is cancelled", async () => {
		shouldShowSelector.mockReturnValue(true);
		selectMode.mockResolvedValue(null);
		await runCommand(main, { rawArgs: [] });

		expect(executeRun).not.toHaveBeenCalled();
		expect(runWorkspace).not.toHaveBeenCalled();
	});

	it("opens the workspace directly when LISA_MODE=workspace", async () => {
		process.env.LISA_MODE = "workspace";
		await runCommand(main, { rawArgs: [] });

		expect(selectMode).not.toHaveBeenCalled();
		expect(runWorkspace).toHaveBeenCalledTimes(1);
	});

	it("runs the workspace subcommand without the loop", async () => {
		await runCommand(main, { rawArgs: ["workspace"] });

		expect(runWorkspace).toHaveBeenCalledTimes(1);
		expect(executeRun).not.toHaveBeenCalled();
	});
});
