import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import pc from "picocolors";
import type { UpdateInfo } from "../version.js";

export type OutputMode = "default" | "tui";
export type LogLevel = "quiet" | "default" | "verbose";

let logFilePath: string | null = null;
let outputMode: OutputMode = "default";
let logLevel: LogLevel = "default";

export function setOutputMode(mode: OutputMode): void {
	outputMode = mode;
}

export function getOutputMode(): OutputMode {
	return outputMode;
}

export function setLogLevel(level: LogLevel): void {
	logLevel = level;
}

export function getLogLevel(): LogLevel {
	return logLevel;
}

function shouldPrintToConsole(): boolean {
	return outputMode !== "tui" && logLevel !== "quiet";
}

export function initLogFile(path: string): void {
	const dir = dirname(path);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(path, `[${timestamp()}] Log started\n`);
	logFilePath = path;
}

function timestamp(): string {
	return new Date().toLocaleTimeString("en-US", { hour12: false });
}

function writeToFile(level: string, message: string): void {
	if (logFilePath) {
		appendFileSync(logFilePath, `[${timestamp()}] [${level}] ${message}\n`);
	}
}

export function log(message: string): void {
	if (shouldPrintToConsole()) {
		console.error(`${pc.cyan("[lisa]")} ${pc.dim(timestamp())} ${message}`);
	}
	writeToFile("info", message);
}

export function warn(message: string): void {
	if (shouldPrintToConsole()) {
		console.error(`${pc.yellow("[lisa]")} ${pc.dim(timestamp())} ${message}`);
	}
	writeToFile("warn", message);
}

export function error(message: string): void {
	if (shouldPrintToConsole()) {
		console.error(`${pc.red("[lisa]")} ${pc.dim(timestamp())} ${message}`);
	}
	writeToFile("error", message);
}

export function ok(message: string): void {
	if (shouldPrintToConsole()) {
		console.error(`${pc.green("[lisa]")} ${pc.dim(timestamp())} ${message}`);
	}
	writeToFile("ok", message);
}

export function verbose(message: string): void {
	if (logLevel !== "verbose") return;
	if (shouldPrintToConsole()) {
		console.error(`${pc.dim("[lisa]")} ${pc.dim(timestamp())} ${pc.dim(message)}`);
	}
	writeToFile("verbose", message);
}

export function divider(session: number): void {
	log(`${"━".repeat(3)} Session ${session} ${"━".repeat(3)}`);
}

export function banner(): void {
	if (outputMode !== "default" || logLevel === "quiet") return;

	const title = " lisa ♪  autonomous issue resolver ";
	const border = "─".repeat(title.length);

	console.error(pc.yellow(`\n  ┌${border}┐`));
	console.error(pc.yellow(`  │`) + pc.bold(pc.white(title)) + pc.yellow("│"));
	console.error(pc.yellow(`  └${border}┘\n`));
}

export function updateNotice(update: UpdateInfo): void {
	if (outputMode !== "default" || logLevel === "quiet") return;

	const msg = `Update available ${pc.dim(update.currentVersion)} → ${pc.green(pc.bold(update.latestVersion))}`;
	const cmd = `Run ${pc.cyan("npm i -g @tarcisiopgs/lisa")} to update`;
	const lines = [msg, cmd];
	// Compute max visible width (strip ANSI for measurement)
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI strip
	const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
	const maxLen = Math.max(...lines.map((l) => strip(l).length));
	const pad = (s: string) => s + " ".repeat(maxLen - strip(s).length);

	console.error(pc.yellow(`  ┌${"─".repeat(maxLen + 2)}┐`));
	for (const line of lines) {
		console.error(pc.yellow("  │ ") + pad(line) + pc.yellow(" │"));
	}
	console.error(pc.yellow(`  └${"─".repeat(maxLen + 2)}┘\n`));
}
