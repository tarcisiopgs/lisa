import { kanbanEmitter } from "../ui/state.js";
import { sleep } from "./helpers.js";

export async function runDemoLoop(): Promise<void> {
	const demoIssues = [
		{ id: "INT-514", title: "Dark mode UI" },
		{ id: "INT-513", title: "WebSocket leak fix" },
		{ id: "INT-512", title: "Rate limiter middleware" },
		{ id: "INT-511", title: "Sidebar navigation icons" },
		{ id: "INT-510", title: "Blog post CRUD" },
		{ id: "INT-509", title: "Admin FAQ management" },
		{ id: "INT-508", title: "Changelog CRUD" },
	];

	// Wait for Ink/React to fully mount and register event listeners
	await sleep(3000);

	kanbanEmitter.emit("provider:model-changed", "claude-sonnet-4-6");
	await sleep(400);

	// Queue all issues into backlog
	for (const issue of demoIssues) {
		kanbanEmitter.emit("issue:queued", {
			id: issue.id,
			title: issue.title,
			description: "",
			url: "",
		});
		await sleep(200);
	}

	await sleep(1000);

	// Issue 1: implement and complete
	const issue1 = demoIssues[0] as (typeof demoIssues)[number];
	kanbanEmitter.emit("issue:started", issue1.id);
	const outputs1 = [
		"Reading issue description...\n",
		"Analyzing codebase structure...\n",
		"Creating src/theme/dark-mode.ts...\n",
		"Updating CSS variables for dark palette...\n",
		"Adding toggle component...\n",
		"Running tests... all passing \u2713\n",
		"Pushing branch int-514-dark-mode-ui...\n",
	];
	for (const line of outputs1) {
		kanbanEmitter.emit("issue:output", issue1.id, line);
		await sleep(500);
	}
	kanbanEmitter.emit("issue:done", issue1.id, ["https://github.com/acme/webapp/pull/91"]);
	await sleep(1000);

	// Issue 2: implement and complete
	const issue2 = demoIssues[1] as (typeof demoIssues)[number];
	kanbanEmitter.emit("issue:started", issue2.id);
	const outputs2 = [
		"Reading issue description...\n",
		"Locating WebSocket connection handler...\n",
		"Patching connection lifecycle in src/ws/handler.ts...\n",
		"Adding cleanup in disconnect callback...\n",
		"Running tests... all passing \u2713\n",
		"Pushing branch int-513-fix-ws-leak...\n",
	];
	for (const line of outputs2) {
		kanbanEmitter.emit("issue:output", issue2.id, line);
		await sleep(500);
	}
	kanbanEmitter.emit("issue:done", issue2.id, ["https://github.com/acme/webapp/pull/92"]);
	await sleep(1000);

	// Issue 3: implement and complete
	const issue3 = demoIssues[2] as (typeof demoIssues)[number];
	kanbanEmitter.emit("issue:started", issue3.id);
	const outputs3 = [
		"Reading issue description...\n",
		"Creating src/middleware/rateLimiter.ts...\n",
		"Writing sliding window rate limiter...\n",
		"Adding tests in rateLimiter.test.ts...\n",
		"Running tests... all passing \u2713\n",
		"Pushing branch int-512-rate-limiting...\n",
	];
	for (const line of outputs3) {
		kanbanEmitter.emit("issue:output", issue3.id, line);
		await sleep(500);
	}
	kanbanEmitter.emit("issue:done", issue3.id, ["https://github.com/acme/webapp/pull/93"]);
	await sleep(1000);

	kanbanEmitter.emit("work:complete", { total: 3, duration: 127000 });
	await sleep(4000);
	kanbanEmitter.emit("tui:exit");
}
