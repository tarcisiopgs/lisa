/**
 * Extract error message from unknown catch parameter.
 * Handles both Error instances and arbitrary thrown values.
 * Recursively includes cause chain when present.
 */
export function formatError(err: unknown): string {
	if (err instanceof Error) {
		const cause = err.cause ? ` (caused by: ${formatError(err.cause)})` : "";
		return `${err.message}${cause}`;
	}
	return String(err);
}
