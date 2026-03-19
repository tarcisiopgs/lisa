import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { Sidebar } from "./sidebar.js";

// Helper to strip ANSI escape codes from rendered output
function stripAnsi(output: string | undefined | null): string {
	if (output === undefined || output === null) return "";
	const ansiStripRegex = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, "g");
	return output.replace(ansiStripRegex, "");
}

import type { SidebarMode } from "./sidebar.js";

const defaultProps = {
	provider: "claude",
	model: null,
	models: [],
	source: "linear",
	cwd: "/tmp/test-workspace",
	activeView: "board" as SidebarMode,
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

describe("Sidebar — legend per mode", () => {
	it("shows board shortcuts in board mode", () => {
		const { lastFrame } = render(<Sidebar {...defaultProps} activeView="board" />);
		const output = stripAnsi(lastFrame());
		expect(output).toContain("[123] jump col");
		expect(output).toContain("[q]  quit");
		expect(output).toContain("[p]  pause");
		expect(output).toContain("columns");
		expect(output).toContain("navigate");
		expect(output).toContain("detail");
	});

	it("shows detail shortcuts in detail mode", () => {
		const { lastFrame } = render(<Sidebar {...defaultProps} activeView="detail" />);
		const output = stripAnsi(lastFrame());
		expect(output).toContain("[Esc] board");
		expect(output).toContain("scroll");
		expect(output).not.toContain("[q]");
		expect(output).not.toContain("[p]");
	});

	it("shows only quit in watching mode", () => {
		const { lastFrame } = render(<Sidebar {...defaultProps} activeView="watching" />);
		const output = stripAnsi(lastFrame());
		expect(output).toContain("[q]  quit");
		expect(output).not.toContain("[p]");
		expect(output).not.toContain("columns");
		expect(output).not.toContain("detail");
	});

	it("shows watch and quit in watch-prompt mode", () => {
		const { lastFrame } = render(<Sidebar {...defaultProps} activeView="watch-prompt" />);
		const output = stripAnsi(lastFrame());
		expect(output).toContain("[w]  watch");
		expect(output).toContain("[q]  quit");
		expect(output).not.toContain("[p]");
	});

	it("shows work summary in watch-prompt mode when workComplete is provided", () => {
		const { lastFrame } = render(
			<Sidebar
				{...defaultProps}
				activeView="watch-prompt"
				workComplete={{ total: 3, duration: 125000 }}
			/>,
		);
		const output = stripAnsi(lastFrame());
		expect(output).toContain("3 issues");
		expect(output).toContain("2m 5s");
	});

	it("shows only quit in empty mode", () => {
		const { lastFrame } = render(<Sidebar {...defaultProps} activeView="empty" />);
		const output = stripAnsi(lastFrame());
		expect(output).toContain("[q]  quit");
		expect(output).not.toContain("[p]");
		expect(output).not.toContain("columns");
		expect(output).not.toContain("detail");
	});

	it("shows open PR in detail mode when hasPrUrl is true", () => {
		const { lastFrame } = render(<Sidebar {...defaultProps} activeView="detail" hasPrUrl={true} />);
		const output = stripAnsi(lastFrame());
		expect(output).toContain("[o]  open PR(s)");
	});

	it("hides open PR in detail mode when hasPrUrl is false", () => {
		const { lastFrame } = render(
			<Sidebar {...defaultProps} activeView="detail" hasPrUrl={false} />,
		);
		const output = stripAnsi(lastFrame());
		expect(output).not.toContain("open PR");
	});

	it("shows kill and skip only when hasInProgress in board mode", () => {
		const { lastFrame: frame1 } = render(
			<Sidebar {...defaultProps} activeView="board" hasInProgress={false} />,
		);
		expect(stripAnsi(frame1())).not.toContain("[k]");
		expect(stripAnsi(frame1())).not.toContain("[s]");

		const { lastFrame: frame2 } = render(
			<Sidebar {...defaultProps} activeView="board" hasInProgress={true} />,
		);
		expect(stripAnsi(frame2())).toContain("[k]  kill");
		expect(stripAnsi(frame2())).toContain("[s]  skip");
	});

	it("shows plan shortcut in board mode", () => {
		const { lastFrame } = render(<Sidebar {...defaultProps} activeView="board" />);
		expect(stripAnsi(lastFrame())).toContain("[n]  plan");
	});

	it("shows send and cancel in plan-chat mode", () => {
		const { lastFrame } = render(<Sidebar {...defaultProps} activeView="plan-chat" />);
		const output = stripAnsi(lastFrame());
		expect(output).toContain("[↵]  send");
		expect(output).toContain("[Esc] cancel");
		expect(output).not.toContain("[q]");
	});

	it("shows review shortcuts in plan-review mode", () => {
		const { lastFrame } = render(<Sidebar {...defaultProps} activeView="plan-review" />);
		const output = stripAnsi(lastFrame());
		expect(output).toContain("navigate");
		expect(output).toContain("[↵]  detail");
		expect(output).toContain("[e]  edit");
		expect(output).toContain("[d]  delete");
		expect(output).toContain("[a]  approve");
		expect(output).toContain("[Esc] cancel");
		expect(output).not.toContain("[q]");
	});
});
