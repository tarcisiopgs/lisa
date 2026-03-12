/**
 * Build NODE_OPTIONS with a heap size flag to prevent OOM crashes when
 * provider CLIs index large workspaces. Preserves any existing NODE_OPTIONS.
 */
export function buildNodeOptions(heapMb = 8192): string {
	const existing = process.env.NODE_OPTIONS ?? "";
	if (existing.includes("max-old-space-size")) {
		return existing;
	}
	return `${existing} --max-old-space-size=${heapMb}`.trim();
}
