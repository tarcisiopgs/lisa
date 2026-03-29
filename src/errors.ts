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

/** Base class for all Lisa domain errors. */
export class LisaError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "LisaError";
	}
}

/** Provider execution errors (agent failed, crashed, timed out). */
export class ProviderError extends LisaError {
	constructor(
		message: string,
		public readonly provider: string,
		public readonly model?: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "ProviderError";
	}
}

/** Source/API errors (Linear, GitHub, Jira, etc.). */
export class SourceError extends LisaError {
	constructor(
		message: string,
		public readonly source: string,
		public readonly statusCode?: number,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "SourceError";
	}
}

/** Timeout errors (session timeout, stuck provider, output stall). */
export class TimeoutError extends LisaError {
	constructor(
		message: string,
		public readonly timeoutMs: number,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "TimeoutError";
	}
}

/** Validation errors (spec compliance, proof of work, plan validation). */
export class ValidationError extends LisaError {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ValidationError";
	}
}
