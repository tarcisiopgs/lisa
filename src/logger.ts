import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
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

function emitJson(level: string, message: string): void {
	const event = { time: timestamp(), level, message };
	jsonEvents.push(event);
	console.log(JSON.stringify(event));
}

export function log(message: string): void {
	if (outputMode === "json") {
		emitJson("info", message);
		return;
	}
	if (outputMode !== "quiet") {
		console.log(`${pc.cyan("[lisa]")} ${pc.dim(timestamp())} ${message}`);
	}
	writeToFile("info", message);
}

export function warn(message: string): void {
	if (outputMode === "json") {
		emitJson("warn", message);
		return;
	}
	if (outputMode !== "quiet") {
		console.error(`${pc.yellow("[lisa]")} ${pc.dim(timestamp())} ${message}`);
	}
	writeToFile("warn", message);
}

export function error(message: string): void {
	if (outputMode === "json") {
		emitJson("error", message);
		return;
	}
	console.error(`${pc.red("[lisa]")} ${pc.dim(timestamp())} ${message}`);
	writeToFile("error", message);
}

export function ok(message: string): void {
	if (outputMode === "json") {
		emitJson("ok", message);
		return;
	}
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

	const art = `
                     @@%#@@
                   @@%=--=%@      @@
          @@@@@@@@%@+------*@%%@%##*@
          @*=======---------===-----@@
          @=------------------------#@
          @=------------------------+@@
         @@=-------------------------+#%%%@@
      @@@#=--------------------------------%@
    @@*=------------------=---------------=@
     @%------=%--=%=--@==+@=--------------@@
      @@+-##+*%**#%=-+*+==+####*---------#@
        @%*%-::::::%#::::::::+@=---------#@
        @@@-:++::::@-::::=::::*%*=--------*@@
          @+:==::::%=::::#-:::%==----------=@@
          @@+:=%%%%*#+::::::+%=-----------=@@
           @%*@=-----=*******---*+=-----=%@
         @%=--+##**#=----------#++##----=@
         @-----------------#=---**+%-----%@
         @%*+=-----===++**#@#--%**#=-==++%@
            @@@%%@#*+++=---=--=%----%%%@@@
                 @@@----------*@#**#@
                 @@@=---------#@@
                @+*%*%%###%*%%=-@
                @%@+=#@==@#:+@##@
                   @@@@%%@##%
`;

	const title = " Lisa — deterministic autonomous issue resolver ";
	const border = "─".repeat(title.length);

	console.log(pc.yellow(art));
	console.log(pc.cyan(`  ┌${border}┐`));
	console.log(pc.cyan(`  │${title}│`));
	console.log(pc.cyan(`  └${border}┘\n`));
}
