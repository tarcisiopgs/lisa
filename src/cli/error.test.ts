import { describe, expect, it } from "vitest";
import { CliError } from "./error.js";

describe("CliError", () => {
	it("has default exit code of 1", () => {
		const err = new CliError("test");
		expect(err.exitCode).toBe(1);
		expect(err.message).toBe("test");
		expect(err.name).toBe("CliError");
	});

	it("accepts custom exit code", () => {
		const err = new CliError("test", 2);
		expect(err.exitCode).toBe(2);
	});

	it("is an instance of Error", () => {
		const err = new CliError("test");
		expect(err).toBeInstanceOf(Error);
	});
});
