process.on("uncaughtException", () => {
	process.exit(1);
});

process.on("unhandledRejection", () => {
	process.exit(1);
});

import { runCli } from "./cli/index.js";

// Fire update check early (non-blocking, cached for 24h)
import("./cli/detection.js").then(({ getVersion }) =>
	import("./version.js").then(({ checkForUpdate }) => checkForUpdate(getVersion())),
);

runCli();
