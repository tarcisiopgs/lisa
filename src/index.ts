import { reportCrash } from "./telemetry.js";

// Install process-level crash handlers before starting the CLI.
// These fire only for unhandled exceptions and unhandled promise rejections.
// Reporting is a best-effort fire-and-forget; the process still exits normally.

process.on("uncaughtException", (error) => {
	reportCrash(error).finally(() => {
		process.exit(1);
	});
});

process.on("unhandledRejection", (reason) => {
	reportCrash(reason).finally(() => {
		process.exit(1);
	});
});

import { runCli } from "./cli.js";

runCli();
