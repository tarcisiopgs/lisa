import { readFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { resolve } from "node:path";

const TELEMETRY_ENDPOINT = "https://telemetry.tarcisiopgs.dev/lisa/crash";

export interface CrashReport {
	lisaVersion: string;
	nodeVersion: string;
	os: string;
	arch: string;
	provider?: string;
	source?: string;
	errorMessage: string;
	stackTrace?: string;
	timestamp: string;
}

export interface TelemetryContext {
	provider?: string;
	source?: string;
}

/**
 * Returns true if telemetry is enabled.
 *
 * Precedence:
 * 1. LISA_NO_TELEMETRY=1 → always disabled (opt-out overrides everything)
 * 2. LISA_TELEMETRY=1    → enabled via environment variable
 * 3. Default             → disabled
 */
export function isTelemetryEnabled(): boolean {
	if (process.env.LISA_NO_TELEMETRY === "1") return false;
	return process.env.LISA_TELEMETRY === "1";
}

function getLisaVersion(): string {
	try {
		const pkgPath = resolve(new URL(".", import.meta.url).pathname, "../package.json");
		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };
		return pkg.version;
	} catch {
		return "unknown";
	}
}

function getOsInfo(): string {
	return `${platform()}-${release()}`;
}

/**
 * Builds a crash report object from an error and optional context.
 * No personally identifiable information is included.
 */
export function buildCrashReport(error: unknown, context: TelemetryContext = {}): CrashReport {
	const isError = error instanceof Error;
	return {
		lisaVersion: getLisaVersion(),
		nodeVersion: process.version,
		os: getOsInfo(),
		arch: arch(),
		provider: context.provider,
		source: context.source,
		errorMessage: isError ? error.message : String(error),
		stackTrace: isError ? error.stack : undefined,
		timestamp: new Date().toISOString(),
	};
}

/**
 * Sends a crash report to the telemetry endpoint.
 * Silently ignores all network or serialization errors — reporting must never crash the CLI.
 */
async function sendReport(report: CrashReport): Promise<void> {
	try {
		const body = JSON.stringify(report);
		// Use global fetch (available in Node 18+)
		await fetch(TELEMETRY_ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
			signal: AbortSignal.timeout(5000),
		});
	} catch {
		// Intentionally swallowed — telemetry must never affect CLI behavior
	}
}

/**
 * Reports a crash or unhandled error if telemetry is enabled.
 * No-op when telemetry is disabled.
 */
export async function reportCrash(error: unknown, context: TelemetryContext = {}): Promise<void> {
	if (!isTelemetryEnabled()) return;
	const report = buildCrashReport(error, context);
	await sendReport(report);
}
