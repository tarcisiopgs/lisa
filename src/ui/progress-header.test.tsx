import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { ProgressHeader } from "./progress-header.js";

// Helper function to strip ANSI escape codes and extract the relevant content line
function stripAnsiAndExtractContent(output: string | undefined | null): string {
	if (output === undefined || output === null) {
		return "";
	}

	// Regex to remove ANSI escape codes (dynamic to prevent biome from converting to a regex literal)
	const ansiStripRegex = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, "g");
	const cleanedOutput = output.replace(ansiStripRegex, "");

	// Split by lines and find the line containing the actual progress text
	// The content is usually on the second line (index 1) after stripping borders
	const lines = cleanedOutput.split("\n");
	if (lines.length >= 2) {
		// Remove leading/trailing box characters and trim whitespace
		const contentLine = lines[1];
		if (contentLine !== undefined) {
			return contentLine
				.replace(/^[┌└ ]*│\s*/, "")
				.replace(/\s*│[┐┘ ]*$/, "")
				.trim();
		}
	}
	return cleanedOutput.trim();
}

describe("ProgressHeader", () => {
	it("renders empty string when total is 0", () => {
		const { rerender, lastFrame } = render(
			<ProgressHeader total={0} done={0} running={0} workComplete={false} />,
		);
		expect(stripAnsiAndExtractContent(lastFrame())).toBe("");

		rerender(<ProgressHeader total={0} done={0} running={0} workComplete={true} />);
		expect(stripAnsiAndExtractContent(lastFrame())).toBe("");
	});

	it("renders progress correctly", () => {
		const { lastFrame } = render(
			<ProgressHeader total={10} done={2} running={1} workComplete={false} />,
		);
		const content = stripAnsiAndExtractContent(lastFrame());
		expect(content).toContain("2/10 (20%) (1 running)");
		expect(content).toContain("█");
		expect(content).toContain("░");
	});

	it("renders 100% green when workComplete is true", () => {
		const { lastFrame } = render(
			<ProgressHeader total={5} done={5} running={0} workComplete={true} />,
		);
		const content = stripAnsiAndExtractContent(lastFrame());
		expect(content).toContain("5/5 (100%)");
		expect(content).not.toContain("░");
	});

	it("renders without running cards when running is 0", () => {
		const { lastFrame } = render(
			<ProgressHeader total={10} done={5} running={0} workComplete={false} />,
		);
		const content = stripAnsiAndExtractContent(lastFrame());
		expect(content).toContain("5/10 (50%)");
		expect(content).not.toContain("(0 running)");
	});

	it("renders yellow when paused", () => {
		const { lastFrame } = render(
			<ProgressHeader total={10} done={2} running={1} workComplete={false} paused={true} />,
		);
		const content = stripAnsiAndExtractContent(lastFrame());
		expect(content).toContain("2/10 (20%) (1 running)");
	});

	it("updates progress when props change", () => {
		const { rerender, lastFrame } = render(
			<ProgressHeader total={10} done={2} running={1} workComplete={false} />,
		);
		expect(stripAnsiAndExtractContent(lastFrame())).toContain("2/10 (20%) (1 running)");

		rerender(<ProgressHeader total={10} done={5} running={0} workComplete={false} />);
		expect(stripAnsiAndExtractContent(lastFrame())).toContain("5/10 (50%)");

		rerender(<ProgressHeader total={10} done={10} running={0} workComplete={true} />);
		expect(stripAnsiAndExtractContent(lastFrame())).toContain("10/10 (100%)");
	});

	it("uses availableWidth prop for bar calculation", () => {
		const { lastFrame } = render(
			<ProgressHeader total={10} done={5} running={0} workComplete={false} availableWidth={80} />,
		);
		const content = stripAnsiAndExtractContent(lastFrame());
		expect(content).toContain("5/10 (50%)");
	});

	it("defaults to stdout.columns when availableWidth is not provided", () => {
		const { lastFrame } = render(
			<ProgressHeader total={10} done={5} running={0} workComplete={false} />,
		);
		const content = stripAnsiAndExtractContent(lastFrame());
		expect(content).toContain("5/10 (50%)");
	});
});
