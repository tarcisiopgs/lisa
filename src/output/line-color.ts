/**
 * Classify a log line for TUI coloring based on structural patterns.
 *
 * Uses a whitelist of error/warning patterns rather than naive keyword matching.
 * Errs on the side of "white" (neutral) to avoid false alarm coloring.
 */
export function logLineColor(line: string): string {
	const trimmed = line.trimStart();

	const isError =
		/^(error|fatal)\s*:/i.test(trimmed) ||
		/^(uncaught|unhandled)\w/i.test(trimmed) ||
		/^✖/.test(trimmed) ||
		/\b(TypeError|SyntaxError|ReferenceError|RangeError|ENOENT|EACCES)\b/.test(line) ||
		/\bat\s+\S+\s+\(/.test(line) ||
		/exited?\s+with\s+(code|status)\s+[1-9]/i.test(line) ||
		/failed\s+with\s+exit\s+code\b/i.test(line);

	if (isError) return "red";

	const isWarning = /^(warn(ing)?)\s*:/i.test(trimmed) || /^⚠/.test(trimmed);

	if (isWarning) return "yellow";

	if (/✔|\bsuccess\b/i.test(line)) return "green";

	return "white";
}
