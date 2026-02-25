import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { platform } from "node:os";

export interface PtyResult {
	proc: ChildProcess;
	isPty: boolean;
}

export interface PtySpawnArgs {
	file: string;
	args: string[];
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: required for ANSI escape sequence stripping
const ANSI_REGEX = /\x1b(?:\[[0-9;?]*[a-zA-Z]|\][^\x07]*\x07|\([A-Z0-9]|[A-Z])/g;

/**
 * Strip ANSI escape sequences and normalize PTY line endings.
 * Used to clean output for logging and result collection.
 */
export function stripAnsi(text: string): string {
	return text.replace(ANSI_REGEX, "").replace(/\r\n/g, "\n").replace(/\r/g, "");
}

/**
 * Build spawn arguments for running a command inside a PTY via `script`.
 * Returns null if the platform is not supported.
 *
 * @param command - The shell command to run inside the PTY
 * @param os - Override platform for testing (defaults to current platform)
 */
export function buildPtyArgs(command: string, os?: NodeJS.Platform): PtySpawnArgs | null {
	const currentOs = os ?? platform();
	if (currentOs === "darwin") {
		// -q: quiet (no "Script started" message)
		// -F: flush output after each write (real-time streaming)
		return { file: "script", args: ["-qF", "/dev/null", "sh", "-c", command] };
	}
	if (currentOs === "linux") {
		// -q: quiet, -e: return child exit code, -f: flush output
		return { file: "script", args: ["-qef", "-c", command, "/dev/null"] };
	}
	return null;
}

/**
 * Spawn a child process with PTY wrapper for real-time output streaming.
 *
 * When running via PTY, the child process sees a real terminal (isatty=true)
 * and uses line-buffered output instead of full buffering, eliminating the
 * output delay caused by pipe buffering (~64KB chunks).
 *
 * Uses the `script` utility (available on macOS and Linux) to create the PTY.
 * Falls back to regular pipe if PTY is not available on the platform.
 */
export function spawnWithPty(command: string, options: SpawnOptions = {}): PtyResult {
	const ptyArgs = buildPtyArgs(command);

	if (ptyArgs) {
		const proc = spawn(ptyArgs.file, ptyArgs.args, {
			...options,
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { proc, isPty: true };
	}

	const proc = spawn("sh", ["-c", command], {
		...options,
		stdio: ["ignore", "pipe", "pipe"],
	});
	return { proc, isPty: false };
}
