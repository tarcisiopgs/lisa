import { describe, expect, it } from "vitest";
import { logLineColor } from "./line-color.js";

describe("logLineColor", () => {
	describe("structural errors → red", () => {
		it("line starting with Error:", () => {
			expect(logLineColor("Error: module not found")).toBe("red");
		});

		it("line starting with fatal:", () => {
			expect(logLineColor("  fatal: not a git repository")).toBe("red");
		});

		it("uncaught exception", () => {
			expect(logLineColor("UncaughtException: something broke")).toBe("red");
		});

		it("unhandled rejection", () => {
			expect(logLineColor("UnhandledPromiseRejection: oops")).toBe("red");
		});

		it("JS TypeError", () => {
			expect(logLineColor("TypeError: Cannot read properties of undefined")).toBe("red");
		});

		it("JS SyntaxError", () => {
			expect(logLineColor("SyntaxError: Unexpected token")).toBe("red");
		});

		it("JS ReferenceError", () => {
			expect(logLineColor("ReferenceError: x is not defined")).toBe("red");
		});

		it("JS RangeError", () => {
			expect(logLineColor("RangeError: Maximum call stack size exceeded")).toBe("red");
		});

		it("ENOENT error", () => {
			expect(logLineColor("ENOENT: no such file or directory")).toBe("red");
		});

		it("EACCES error", () => {
			expect(logLineColor("EACCES: permission denied")).toBe("red");
		});

		it("stack trace line", () => {
			expect(
				logLineColor("    at Module._compile (node:internal/modules/cjs/loader:1254:14)"),
			).toBe("red");
		});

		it("exit code non-zero", () => {
			expect(logLineColor("Process exited with code 1")).toBe("red");
		});

		it("failed with exit code", () => {
			expect(logLineColor("Command failed with exit code 127")).toBe("red");
		});

		it("error marker ✖", () => {
			expect(logLineColor("✖ Compilation failed")).toBe("red");
		});
	});

	describe("casual mentions → white", () => {
		it("task description with error keyword", () => {
			expect(logLineColor("fix error handling in auth module")).toBe("white");
		});

		it("provider searching for error patterns", () => {
			expect(logLineColor("Searching for error patterns")).toBe("white");
		});

		it("transient API retry message", () => {
			expect(logLineColor("Request failed due to a transient API error. Retrying...")).toBe(
				"white",
			);
		});

		it("component name with error", () => {
			expect(logLineColor("Add error boundary component")).toBe("white");
		});

		it("phrase with warning in the middle", () => {
			expect(logLineColor("warning the user about invalid input")).toBe("white");
		});

		it("grep for error keyword", () => {
			expect(logLineColor('Grep "error"')).toBe("white");
		});
	});

	describe("structural warnings → yellow", () => {
		it("line starting with warning:", () => {
			expect(logLineColor("warning: deprecated API usage")).toBe("yellow");
		});

		it("warning marker ⚠", () => {
			expect(logLineColor("⚠ peer dependency not met")).toBe("yellow");
		});

		it("line starting with warn:", () => {
			expect(logLineColor("warn: something is off")).toBe("yellow");
		});
	});

	describe("success → green", () => {
		it("success marker ✔", () => {
			expect(logLineColor("✔ All tests passed")).toBe("green");
		});

		it("line containing success", () => {
			expect(logLineColor("Build success")).toBe("green");
		});
	});
});
