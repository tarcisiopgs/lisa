import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import pc from "picocolors";

export type OutputMode = "default" | "json" | "quiet";

let logFilePath: string | null = null;
let outputMode: OutputMode = "default";

const jsonEvents: Record<string, unknown>[] = [];

export function setOutputMode(mode: OutputMode): void {
	outputMode = mode;
}

export function getJsonEvents(): Record<string, unknown>[] {
	return jsonEvents;
}

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

function emitJson(level: string, message: string): void {
	const event = { time: timestamp(), level, message };
	jsonEvents.push(event);
	console.log(JSON.stringify(event));
}

export function log(message: string): void {
	if (outputMode === "json") return emitJson("info", message);
	if (outputMode !== "quiet") {
		console.log(`${pc.cyan("[lisa]")} ${pc.dim(timestamp())} ${message}`);
	}
	writeToFile("info", message);
}

export function warn(message: string): void {
	if (outputMode === "json") return emitJson("warn", message);
	if (outputMode !== "quiet") {
		console.error(`${pc.yellow("[lisa]")} ${pc.dim(timestamp())} ${message}`);
	}
	writeToFile("warn", message);
}

export function error(message: string): void {
	if (outputMode === "json") return emitJson("error", message);
	console.error(`${pc.red("[lisa]")} ${pc.dim(timestamp())} ${message}`);
	writeToFile("error", message);
}

export function ok(message: string): void {
	if (outputMode === "json") return emitJson("ok", message);
	if (outputMode !== "quiet") {
		console.log(`${pc.green("[lisa]")} ${pc.dim(timestamp())} ${message}`);
	}
	writeToFile("ok", message);
}

export function divider(session: number): void {
	log(`${"━".repeat(3)} Session ${session} ${"━".repeat(3)}`);
}

export function banner(): void {
	if (outputMode !== "default") return;
	console.log(
		pc.cyan(`
  ┌─────────────────────────────────────┐
  │  lisa — autonomous issue resolver  │
  └─────────────────────────────────────┘
`),
	);
}
