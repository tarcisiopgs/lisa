const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

let spinnerTimer: ReturnType<typeof setInterval> | null = null;
let spinnerFrame = 0;

function isTTY(): boolean {
	return process.stdout.isTTY === true;
}

function writeOSC(title: string): void {
	process.stdout.write(`\x1b]0;${title}\x07`);
}

export function setTitle(title: string): void {
	if (!isTTY()) return;
	writeOSC(title);
}

export function startSpinner(message: string): void {
	if (!isTTY()) return;
	stopSpinner();
	spinnerFrame = 0;
	writeOSC(`${SPINNER_FRAMES[0]} Lisa \u2014 ${message}`);
	spinnerTimer = setInterval(() => {
		spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
		writeOSC(`${SPINNER_FRAMES[spinnerFrame]} Lisa \u2014 ${message}`);
	}, SPINNER_INTERVAL_MS);
}

export function stopSpinner(message?: string): void {
	if (spinnerTimer) {
		clearInterval(spinnerTimer);
		spinnerTimer = null;
	}
	if (!isTTY()) return;
	if (message) {
		writeOSC(message);
	}
}

export function notify(): void {
	if (!isTTY()) return;
	process.stdout.write("\x07");
}

export function resetTitle(): void {
	if (!isTTY()) return;
	writeOSC("");
}
