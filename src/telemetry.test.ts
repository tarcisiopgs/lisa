import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCrashReport, isTelemetryEnabled, reportCrash } from "./telemetry.js";

describe("isTelemetryEnabled", () => {
	const originalEnv = process.env;

	beforeEach(() => {
		process.env = { ...originalEnv };
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	it("returns false by default (neither env var set)", () => {
		delete process.env.LISA_TELEMETRY;
		delete process.env.LISA_NO_TELEMETRY;
		expect(isTelemetryEnabled()).toBe(false);
	});

	it("returns true when LISA_TELEMETRY=1", () => {
		process.env.LISA_TELEMETRY = "1";
		delete process.env.LISA_NO_TELEMETRY;
		expect(isTelemetryEnabled()).toBe(true);
	});

	it("returns false when LISA_NO_TELEMETRY=1 (opt-out overrides opt-in)", () => {
		process.env.LISA_TELEMETRY = "1";
		process.env.LISA_NO_TELEMETRY = "1";
		expect(isTelemetryEnabled()).toBe(false);
	});

	it("returns false when LISA_NO_TELEMETRY=1 and LISA_TELEMETRY unset", () => {
		delete process.env.LISA_TELEMETRY;
		process.env.LISA_NO_TELEMETRY = "1";
		expect(isTelemetryEnabled()).toBe(false);
	});

	it("returns false when LISA_TELEMETRY is not '1'", () => {
		process.env.LISA_TELEMETRY = "true";
		delete process.env.LISA_NO_TELEMETRY;
		expect(isTelemetryEnabled()).toBe(false);
	});
});

describe("buildCrashReport", () => {
	it("includes error message and stack from an Error instance", () => {
		const err = new Error("something went wrong");
		const report = buildCrashReport(err);

		expect(report.errorMessage).toBe("something went wrong");
		expect(report.stackTrace).toContain("Error: something went wrong");
	});

	it("converts non-Error values to string", () => {
		const report = buildCrashReport("plain string error");
		expect(report.errorMessage).toBe("plain string error");
		expect(report.stackTrace).toBeUndefined();
	});

	it("includes Node version and arch", () => {
		const report = buildCrashReport(new Error("x"));
		expect(report.nodeVersion).toBe(process.version);
		expect(report.arch).toBeTruthy();
	});

	it("includes os info", () => {
		const report = buildCrashReport(new Error("x"));
		expect(report.os).toBeTruthy();
	});

	it("includes provider and source from context", () => {
		const report = buildCrashReport(new Error("x"), { provider: "claude", source: "linear" });
		expect(report.provider).toBe("claude");
		expect(report.source).toBe("linear");
	});

	it("leaves provider and source undefined when not provided", () => {
		const report = buildCrashReport(new Error("x"));
		expect(report.provider).toBeUndefined();
		expect(report.source).toBeUndefined();
	});

	it("includes a valid ISO timestamp", () => {
		const before = Date.now();
		const report = buildCrashReport(new Error("x"));
		const after = Date.now();
		const ts = new Date(report.timestamp).getTime();
		expect(ts).toBeGreaterThanOrEqual(before);
		expect(ts).toBeLessThanOrEqual(after);
	});

	it("includes a lisaVersion string", () => {
		const report = buildCrashReport(new Error("x"));
		// May be "unknown" in test environment, but must be a string
		expect(typeof report.lisaVersion).toBe("string");
	});
});

describe("reportCrash", () => {
	const originalEnv = process.env;

	beforeEach(() => {
		process.env = { ...originalEnv };
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
	});

	afterEach(() => {
		process.env = originalEnv;
		vi.unstubAllGlobals();
	});

	it("does not call fetch when telemetry is disabled", async () => {
		delete process.env.LISA_TELEMETRY;
		delete process.env.LISA_NO_TELEMETRY;
		await reportCrash(new Error("test"));
		expect(fetch).not.toHaveBeenCalled();
	});

	it("calls fetch when LISA_TELEMETRY=1", async () => {
		process.env.LISA_TELEMETRY = "1";
		delete process.env.LISA_NO_TELEMETRY;
		await reportCrash(new Error("test"));
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("does not throw when fetch rejects", async () => {
		process.env.LISA_TELEMETRY = "1";
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
		await expect(reportCrash(new Error("test"))).resolves.toBeUndefined();
	});

	it("does not call fetch when LISA_NO_TELEMETRY=1 overrides LISA_TELEMETRY=1", async () => {
		process.env.LISA_TELEMETRY = "1";
		process.env.LISA_NO_TELEMETRY = "1";
		await reportCrash(new Error("test"));
		expect(fetch).not.toHaveBeenCalled();
	});

	it("posts JSON to the telemetry endpoint", async () => {
		process.env.LISA_TELEMETRY = "1";
		delete process.env.LISA_NO_TELEMETRY;
		await reportCrash(new Error("details"), { provider: "gemini", source: "trello" });

		expect(fetch).toHaveBeenCalledOnce();
		const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
		expect(url).toContain("telemetry.lisa.sh");
		expect(init.method).toBe("POST");
		const body = JSON.parse(init.body as string) as Record<string, unknown>;
		expect(body.errorMessage).toBe("details");
		expect(body.provider).toBe("gemini");
		expect(body.source).toBe("trello");
	});
});
