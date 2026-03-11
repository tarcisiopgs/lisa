import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import pc from "picocolors";

export type OutputMode = "default" | "tui";

let logFilePath: string | null = null;
let outputMode: OutputMode = "default";

export function setOutputMode(mode: OutputMode): void {
	outputMode = mode;
}

export function getOutputMode(): OutputMode {
	return outputMode;
}

function shouldPrintToConsole(): boolean {
	return outputMode !== "tui";
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
		console.log(`${pc.cyan("[lisa]")} ${pc.dim(timestamp())} ${message}`);
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
		console.log(`${pc.green("[lisa]")} ${pc.dim(timestamp())} ${message}`);
	}
	writeToFile("ok", message);
}

export function divider(session: number): void {
	log(`${"━".repeat(3)} Session ${session} ${"━".repeat(3)}`);
}

export function banner(): void {
	if (outputMode !== "default") return;

	const title = " lisa ♪  autonomous issue resolver ";
	const border = "─".repeat(title.length);

	console.log(pc.yellow(`\n  ┌${border}┐`));
	console.log(pc.yellow(`  │`) + pc.bold(pc.white(title)) + pc.yellow("│"));
	console.log(pc.yellow(`  └${border}┘\n`));
}
