/**
 * Extract error message from unknown catch parameter.
 * Handles both Error instances and arbitrary thrown values.
 */
export function formatError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
