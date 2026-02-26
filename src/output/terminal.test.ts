import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notify, resetTitle, setTitle, startSpinner, stopSpinner } from "./terminal.js";

describe("terminal (non-TTY)", () => {
	let writeSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		// vitest runs in a pipe — process.stdout.isTTY is undefined
		writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		stopSpinner();
		writeSpy.mockRestore();
	});

	it("setTitle is a no-op when not a TTY", () => {
		setTitle("test");
		expect(writeSpy).not.toHaveBeenCalled();
	});

	it("startSpinner is a no-op when not a TTY", () => {
		startSpinner("working...");
		expect(writeSpy).not.toHaveBeenCalled();
	});

	it("stopSpinner clears timer even when not a TTY", () => {
		// Should not throw
		stopSpinner();
		stopSpinner("done");
		expect(writeSpy).not.toHaveBeenCalled();
	});

	it("notify is a no-op when not a TTY", () => {
		notify();
		expect(writeSpy).not.toHaveBeenCalled();
	});

	it("resetTitle is a no-op when not a TTY", () => {
		resetTitle();
		expect(writeSpy).not.toHaveBeenCalled();
	});
});

describe("terminal (TTY)", () => {
	let writeSpy: ReturnType<typeof vi.spyOn>;
	let isTTYDescriptor: PropertyDescriptor | undefined;

	beforeEach(() => {
		writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		isTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	});

	afterEach(() => {
		stopSpinner();
		writeSpy.mockRestore();
		if (isTTYDescriptor) {
			Object.defineProperty(process.stdout, "isTTY", isTTYDescriptor);
		} else {
			delete (process.stdout as unknown as Record<string, unknown>).isTTY;
		}
	});

	it("setTitle writes OSC escape sequence", () => {
		setTitle("Lisa — LIN-123");
		expect(writeSpy).toHaveBeenCalledWith("\x1b]0;Lisa — LIN-123\x07");
	});

	it("startSpinner writes first frame immediately", () => {
		startSpinner("fetching...");
		expect(writeSpy).toHaveBeenCalledWith("\x1b]0;⠋ Lisa — fetching...\x07");
	});

	it("startSpinner cycles frames on interval", async () => {
		vi.useFakeTimers();
		startSpinner("working...");
		writeSpy.mockClear();

		vi.advanceTimersByTime(80);
		expect(writeSpy).toHaveBeenCalledWith("\x1b]0;⠙ Lisa — working...\x07");

		writeSpy.mockClear();
		vi.advanceTimersByTime(80);
		expect(writeSpy).toHaveBeenCalledWith("\x1b]0;⠹ Lisa — working...\x07");

		vi.useRealTimers();
	});

	it("stopSpinner stops the interval", () => {
		vi.useFakeTimers();
		startSpinner("working...");
		stopSpinner();
		writeSpy.mockClear();

		vi.advanceTimersByTime(200);
		expect(writeSpy).not.toHaveBeenCalled();

		vi.useRealTimers();
	});

	it("stopSpinner with message sets final title", () => {
		startSpinner("working...");
		writeSpy.mockClear();
		stopSpinner("✓ Done");
		expect(writeSpy).toHaveBeenCalledWith("\x1b]0;✓ Done\x07");
	});

	it("startSpinner stops previous spinner before starting new one", () => {
		vi.useFakeTimers();
		startSpinner("first");
		startSpinner("second");
		writeSpy.mockClear();

		vi.advanceTimersByTime(80);
		// Should only get frames for "second", not "first"
		const calls = writeSpy.mock.calls.map((c: unknown[]) => c[0] as string);
		expect(calls.every((c: string) => c.includes("second"))).toBe(true);
		expect(calls.some((c: string) => c.includes("first"))).toBe(false);

		vi.useRealTimers();
	});

	it("notify writes BEL character", () => {
		notify();
		expect(writeSpy).toHaveBeenCalledWith("\x07");
	});

	it("notify with count=2 writes two BEL characters", () => {
		notify(2);
		expect(writeSpy).toHaveBeenCalledWith("\x07\x07");
	});

	it("notify with count=3 writes three BEL characters", () => {
		notify(3);
		expect(writeSpy).toHaveBeenCalledWith("\x07\x07\x07");
	});

	it("resetTitle writes empty OSC sequence", () => {
		resetTitle();
		expect(writeSpy).toHaveBeenCalledWith("\x1b]0;\x07");
	});
});
