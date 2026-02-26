import { Text } from "ink";
import { render } from "ink-testing-library";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useTerminalSize } from "./use-terminal-size.js";

function SizeDisplay() {
	const { columns, rows } = useTerminalSize();
	return <Text>{`${columns}x${rows}`}</Text>;
}

describe("useTerminalSize", () => {
	let originalColumns: number | undefined;
	let originalRows: number | undefined;

	beforeEach(() => {
		originalColumns = process.stdout.columns;
		originalRows = process.stdout.rows;
	});

	afterEach(() => {
		Object.defineProperty(process.stdout, "columns", {
			value: originalColumns,
			configurable: true,
			writable: true,
		});
		Object.defineProperty(process.stdout, "rows", {
			value: originalRows,
			configurable: true,
			writable: true,
		});
	});

	it("returns current terminal dimensions on initial render", () => {
		Object.defineProperty(process.stdout, "columns", {
			value: 120,
			configurable: true,
			writable: true,
		});
		Object.defineProperty(process.stdout, "rows", {
			value: 40,
			configurable: true,
			writable: true,
		});

		const { lastFrame } = render(<SizeDisplay />);
		expect(lastFrame()).toContain("120x40");
	});

	it("falls back to 80 columns when process.stdout.columns is undefined", () => {
		Object.defineProperty(process.stdout, "columns", {
			value: undefined,
			configurable: true,
			writable: true,
		});
		Object.defineProperty(process.stdout, "rows", {
			value: 24,
			configurable: true,
			writable: true,
		});

		const { lastFrame } = render(<SizeDisplay />);
		expect(lastFrame()).toContain("80x24");
	});

	it("falls back to 24 rows when process.stdout.rows is undefined", () => {
		Object.defineProperty(process.stdout, "columns", {
			value: 80,
			configurable: true,
			writable: true,
		});
		Object.defineProperty(process.stdout, "rows", {
			value: undefined,
			configurable: true,
			writable: true,
		});

		const { lastFrame } = render(<SizeDisplay />);
		expect(lastFrame()).toContain("80x24");
	});

	it("updates dimensions when process.stdout emits resize event", async () => {
		Object.defineProperty(process.stdout, "columns", {
			value: 100,
			configurable: true,
			writable: true,
		});
		Object.defineProperty(process.stdout, "rows", {
			value: 30,
			configurable: true,
			writable: true,
		});

		const { lastFrame } = render(<SizeDisplay />);
		expect(lastFrame()).toContain("100x30");

		await act(async () => {
			Object.defineProperty(process.stdout, "columns", {
				value: 150,
				configurable: true,
				writable: true,
			});
			Object.defineProperty(process.stdout, "rows", {
				value: 50,
				configurable: true,
				writable: true,
			});
			process.stdout.emit("resize");
		});

		expect(lastFrame()).toContain("150x50");
	});

	it("cleans up the resize listener on unmount", () => {
		Object.defineProperty(process.stdout, "columns", {
			value: 80,
			configurable: true,
			writable: true,
		});
		Object.defineProperty(process.stdout, "rows", {
			value: 24,
			configurable: true,
			writable: true,
		});

		const listenersBefore = process.stdout.listenerCount("resize");
		const { unmount } = render(<SizeDisplay />);

		expect(process.stdout.listenerCount("resize")).toBe(listenersBefore + 1);
		unmount();
		expect(process.stdout.listenerCount("resize")).toBe(listenersBefore);
	});
});
