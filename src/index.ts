import { CliError } from "./cli/error.js";

process.on("uncaughtException", (err) => {
	if (err instanceof CliError) {
		process.exit(err.exitCode);
	}
	process.exit(1);
});

process.on("unhandledRejection", (err) => {
	if (err instanceof CliError) {
		process.exit((err as CliError).exitCode);
	}
	process.exit(1);
});

import { runCli } from "./cli/index.js";

// Fire update check early (non-blocking, cached for 24h)
import("./cli/detection.js").then(({ getVersion }) =>
	import("./version.js").then(({ checkForUpdate }) => checkForUpdate(getVersion())),
);

runCli();
