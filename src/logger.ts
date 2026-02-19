import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import pc from "picocolors";

let logFilePath: string | null = null;

export function initLogFile(path: string): void {
	const dir = dirname(path);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
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
	console.log(`${pc.cyan("[matuto]")} ${pc.dim(timestamp())} ${message}`);
	writeToFile("info", message);
}

export function warn(message: string): void {
	console.log(`${pc.yellow("[matuto]")} ${pc.dim(timestamp())} ${message}`);
	writeToFile("warn", message);
}

export function error(message: string): void {
	console.log(`${pc.red("[matuto]")} ${pc.dim(timestamp())} ${message}`);
	writeToFile("error", message);
}

export function ok(message: string): void {
	console.log(`${pc.green("[matuto]")} ${pc.dim(timestamp())} ${message}`);
	writeToFile("ok", message);
}

export function divider(session: number): void {
	log(`${"━".repeat(3)} Session ${session} ${"━".repeat(3)}`);
}

export function banner(): void {
	console.log(
		pc.cyan(`
  ┌─────────────────────────────────────────┐
  │  matuto — o cabra que resolve suas issues │
  └─────────────────────────────────────────┘
`),
	);
}
