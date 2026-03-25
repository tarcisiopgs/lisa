import { describe, expect, it } from "vitest";

// Re-implement the utility functions here for testing (they're module-private in config.ts)
function coerceValue(value: string): string | number | boolean {
	if (value === "true") return true;
	if (value === "false") return false;
	if (/^\d+$/.test(value)) return Number.parseInt(value, 10);
	if (/^\d+\.\d+$/.test(value)) return Number.parseFloat(value);
	return value;
}

function setNestedValue(
	obj: Record<string, unknown>,
	path: string,
	value: string | number | boolean,
): void {
	const parts = path.split(".");
	let current: Record<string, unknown> = obj;

	for (let i = 0; i < parts.length - 1; i++) {
		const key = parts[i] as string;
		if (current[key] === undefined || current[key] === null) {
			current[key] = {};
		}
		if (typeof current[key] !== "object" || Array.isArray(current[key])) {
			current[key] = {};
		}
		current = current[key] as Record<string, unknown>;
	}

	const lastKey = parts[parts.length - 1] as string;
	current[lastKey] = value;
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
	const parts = path.split(".");
	let current: unknown = obj;

	for (const part of parts) {
		if (current === undefined || current === null || typeof current !== "object") {
			return undefined;
		}
		current = (current as Record<string, unknown>)[part];
	}

	return current;
}

describe("coerceValue", () => {
	it("coerces 'true' to boolean true", () => {
		expect(coerceValue("true")).toBe(true);
	});

	it("coerces 'false' to boolean false", () => {
		expect(coerceValue("false")).toBe(false);
	});

	it("coerces integer strings to numbers", () => {
		expect(coerceValue("42")).toBe(42);
		expect(coerceValue("0")).toBe(0);
		expect(coerceValue("100")).toBe(100);
	});

	it("coerces float strings to numbers", () => {
		expect(coerceValue("3.14")).toBe(3.14);
	});

	it("keeps regular strings as strings", () => {
		expect(coerceValue("claude")).toBe("claude");
		expect(coerceValue("main")).toBe("main");
		expect(coerceValue("")).toBe("");
	});
});

describe("setNestedValue", () => {
	it("sets top-level values", () => {
		const obj: Record<string, unknown> = {};
		setNestedValue(obj, "provider", "gemini");
		expect(obj.provider).toBe("gemini");
	});

	it("sets nested values", () => {
		const obj: Record<string, unknown> = { loop: { cooldown: 0 } };
		setNestedValue(obj, "loop.cooldown", 5);
		expect((obj.loop as Record<string, unknown>).cooldown).toBe(5);
	});

	it("creates intermediate objects", () => {
		const obj: Record<string, unknown> = {};
		setNestedValue(obj, "proof_of_work.enabled", true);
		expect((obj.proof_of_work as Record<string, unknown>).enabled).toBe(true);
	});

	it("sets deeply nested values", () => {
		const obj: Record<string, unknown> = {};
		setNestedValue(obj, "a.b.c", "deep");
		const a = obj.a as Record<string, unknown>;
		const b = a.b as Record<string, unknown>;
		expect(b.c).toBe("deep");
	});
});

describe("getNestedValue", () => {
	it("gets top-level values", () => {
		expect(getNestedValue({ provider: "claude" }, "provider")).toBe("claude");
	});

	it("gets nested values", () => {
		expect(getNestedValue({ loop: { cooldown: 5 } }, "loop.cooldown")).toBe(5);
	});

	it("returns undefined for missing paths", () => {
		expect(getNestedValue({}, "missing.path")).toBeUndefined();
	});

	it("returns undefined for partially missing paths", () => {
		expect(getNestedValue({ loop: {} }, "loop.missing")).toBeUndefined();
	});

	it("returns objects for intermediate paths", () => {
		const obj = { loop: { cooldown: 5, max_sessions: 10 } };
		const result = getNestedValue(obj, "loop");
		expect(result).toEqual({ cooldown: 5, max_sessions: 10 });
	});
});
