import { kanbanEmitter } from "../ui/state.js";
import { sleep } from "./helpers.js";

export async function runDemoLoop(): Promise<void> {
	const demoIssues = [
		{ id: "INT-512", title: "Rate limiter" },
		{ id: "INT-513", title: "WebSocket leak" },
		{ id: "INT-514", title: "Dark mode UI" },
	];

	// Wait for Ink/React to fully mount and register event listeners
	await sleep(3000);

	kanbanEmitter.emit("provider:model-changed", "claude-sonnet-4-6");
	await sleep(400);

	for (const issue of demoIssues) {
		kanbanEmitter.emit("issue:queued", {
			id: issue.id,
			title: issue.title,
			description: "",
			url: "",
		});
		await sleep(300);
	}

	await sleep(600);

	// Issue 1: implement and complete
	const issue1 = demoIssues[0]!;
	kanbanEmitter.emit("issue:started", issue1.id);
	const outputs1 = [
		"Reading issue description...\n",
		"Analyzing codebase structure...\n",
		"Creating src/middleware/rateLimiter.ts...\n",
		"Writing rate limiter logic...\n",
		"Adding tests in src/middleware/rateLimiter.test.ts...\n",
		"Running tests... all passing \u2713\n",
		"Pushing branch int-512-rate-limiting...\n",
	];
	for (const line of outputs1) {
		kanbanEmitter.emit("issue:output", issue1.id, line);
		await sleep(400);
	}
	kanbanEmitter.emit("issue:done", issue1.id, ["https://github.com/acme/webapp/pull/89"]);
	await sleep(800);

	// Issue 2: implement and complete
	const issue2 = demoIssues[1]!;
	kanbanEmitter.emit("issue:started", issue2.id);
	const outputs2 = [
		"Reading issue description...\n",
		"Locating WebSocket connection handler...\n",
		"Patching connection lifecycle in src/ws/handler.ts...\n",
		"Adding cleanup in disconnect callback...\n",
		"Pushing branch int-513-fix-ws-memory-leak...\n",
	];
	for (const line of outputs2) {
		kanbanEmitter.emit("issue:output", issue2.id, line);
		await sleep(400);
	}
	kanbanEmitter.emit("issue:done", issue2.id, ["https://github.com/acme/webapp/pull/90"]);
	await sleep(800);

	kanbanEmitter.emit("work:complete", { total: 2, duration: 14000 });
	await sleep(3000);
	kanbanEmitter.emit("tui:exit");
}
