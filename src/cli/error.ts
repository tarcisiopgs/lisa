/**
 * Typed CLI error that propagates to the entry point instead of calling process.exit().
 * The main entry point catches these and exits with the appropriate code.
 */
export class CliError extends Error {
	readonly exitCode: number;

	constructor(message: string, exitCode = 1) {
		super(message);
		this.name = "CliError";
		this.exitCode = exitCode;
	}
}
