import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { Sidebar } from "./sidebar.js";

// Helper to strip ANSI escape codes from rendered output
function stripAnsi(output: string | undefined | null): string {
	if (output === undefined || output === null) return "";
	const ansiStripRegex = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, "g");
	return output.replace(ansiStripRegex, "");
}

const defaultProps = {
	provider: "claude",
	model: null,
	models: [],
	source: "linear",
	cwd: "/tmp/test-workspace",
	activeView: "board" as const,
};

describe("Sidebar — MODEL display", () => {
	it("renders model name in uppercase", () => {
		const { lastFrame } = render(
			<Sidebar {...defaultProps} model="claude-sonnet-4-6" models={[]} />,
		);
		const output = stripAnsi(lastFrame());
		expect(output).toContain("CLAUDE-SONNET-4-6");
		expect(output).not.toContain("claude-sonnet-4-6");
	});

	it("renders 'DEFAULT' when model is null", () => {
		const { lastFrame } = render(<Sidebar {...defaultProps} model={null} models={[]} />);
		const output = stripAnsi(lastFrame());
		expect(output).toContain("DEFAULT");
		expect(output).not.toContain("default");
	});

	it("truncates model name longer than 19 chars with ellipsis", () => {
		const { lastFrame } = render(
			<Sidebar {...defaultProps} model="claude-very-long-model-name-here" models={[]} />,
		);
		const output = stripAnsi(lastFrame());
		// Should be truncated to 18 chars + ellipsis
		expect(output).toContain("CLAUDE-VERY-LONG-M…");
		expect(output).not.toContain("CLAUDE-VERY-LONG-MODEL-NAME-HERE");
	});

	it("does not truncate model name of exactly 19 chars", () => {
		// 19 chars: "claude-sonnet-4-6-x"
		const model19 = "claude-sonnet-4-6-x"; // 19 chars
		expect(model19.length).toBe(19);
		const { lastFrame } = render(<Sidebar {...defaultProps} model={model19} models={[]} />);
		const output = stripAnsi(lastFrame());
		expect(output).toContain(model19.toUpperCase());
		expect(output).not.toContain("…");
	});
});

describe("Sidebar — MODEL QUEUE display", () => {
	it("renders all model queue items in uppercase", () => {
		const models = ["claude-sonnet-4-6", "claude-opus-4-6"];
		const { lastFrame } = render(
			<Sidebar {...defaultProps} model="claude-sonnet-4-6" models={models} />,
		);
		const output = stripAnsi(lastFrame());
		expect(output).toContain("CLAUDE-SONNET-4-6");
		expect(output).toContain("CLAUDE-OPUS-4-6");
		expect(output).not.toContain("claude-sonnet-4-6");
		expect(output).not.toContain("claude-opus-4-6");
	});

	it("truncates long model names in queue with ellipsis", () => {
		const longModel = "claude-very-long-model-name-here";
		const models = [longModel, "claude-haiku-4-5"];
		const { lastFrame } = render(<Sidebar {...defaultProps} model={longModel} models={models} />);
		const output = stripAnsi(lastFrame());
		expect(output).toContain("CLAUDE-VERY-LONG-M…");
		expect(output).not.toContain(longModel.toUpperCase());
	});

	it("does not truncate short model names in queue", () => {
		const models = ["gemini-2.5-pro", "gemini-2.0-flash"];
		const { lastFrame } = render(
			<Sidebar {...defaultProps} model="gemini-2.5-pro" models={models} />,
		);
		const output = stripAnsi(lastFrame());
		expect(output).toContain("GEMINI-2.5-PRO");
		expect(output).toContain("GEMINI-2.0-FLASH");
	});
});
