import type { PlannedIssue } from "../types/index.js";
import { kanbanEmitter } from "../ui/state.js";
import { sleep } from "./helpers.js";

export async function runDemoLoop(): Promise<void> {
	// Wait for Ink/React to fully mount and register event listeners
	await sleep(3000);

	kanbanEmitter.emit("provider:model-changed", "claude-sonnet-4-6");

	// ── Phase 1: Empty queue → Idle ──────────────────────────────────────
	kanbanEmitter.emit("work:empty");
	await sleep(2000);

	// ── Phase 2: Plan mode ───────────────────────────────────────────────
	kanbanEmitter.emit("demo:open-plan", "Add a FAQ section to the web app");
	await sleep(2500);

	// AI responds with the decomposed plan
	const plannedIssues: PlannedIssue[] = [
		{
			title: "Add FAQ shared types to @playground/shared",
			description: "Create TypeScript interfaces for FAQ data models",
			order: 1,
			dependsOn: [],
			relevantFiles: ["packages/shared/src/types/faq.ts"],
			acceptanceCriteria: ["FAQ type exported", "Tests pass"],
		},
		{
			title: "Create GET /faq API route returning FAQ data",
			description: "Add Fastify route that returns FAQ entries as JSON",
			order: 2,
			dependsOn: [1],
			relevantFiles: ["apps/api/src/routes/faq.ts"],
			acceptanceCriteria: ["GET /faq returns 200", "Response matches schema"],
		},
		{
			title: "Create FAQ page with accordion UI",
			description: "Build the FAQ page component with expandable sections",
			order: 3,
			dependsOn: [1, 2],
			relevantFiles: ["apps/web/src/pages/faq.tsx"],
			acceptanceCriteria: ["Page renders FAQ items", "Accordion expands/collapses"],
		},
		{
			title: "Add FAQ link to the navigation menu",
			description: "Add a navigation entry pointing to the FAQ page",
			order: 4,
			dependsOn: [3],
			relevantFiles: ["apps/web/src/components/nav.tsx"],
			acceptanceCriteria: ["Link visible in nav", "Navigates to /faq"],
		},
	];

	kanbanEmitter.emit("plan:issues-ready", plannedIssues);
	await sleep(3000);

	// ── Phase 3: Approve plan → Issues appear in backlog ─────────────────
	kanbanEmitter.emit("demo:approve-plan");
	await sleep(500);

	const demoIssues = [
		{ id: "INT-601", title: "Add FAQ shared types to @playground/shared" },
		{ id: "INT-602", title: "Create GET /faq API route returning FAQ data" },
		{ id: "INT-603", title: "Create FAQ page with accordion UI" },
		{ id: "INT-604", title: "Add FAQ link to the navigation menu" },
	];

	for (const issue of demoIssues) {
		kanbanEmitter.emit("issue:queued", {
			id: issue.id,
			title: issue.title,
			description: "",
			url: "",
		});
		await sleep(200);
	}

	kanbanEmitter.emit("work:resumed");
	await sleep(1500);

	// ── Phase 4: Process issues ──────────────────────────────────────────
	for (let i = 0; i < demoIssues.length; i++) {
		const issue = demoIssues[i] as (typeof demoIssues)[number];
		kanbanEmitter.emit("issue:started", issue.id);

		const steps = [
			"Reading issue description...\n",
			"Analyzing codebase...\n",
			"Implementing changes...\n",
			"Running tests... all passing \u2713\n",
			`Pushing branch feat/${issue.id.toLowerCase()}...\n`,
		];

		for (const step of steps) {
			kanbanEmitter.emit("issue:output", issue.id, step);
			await sleep(400);
		}

		kanbanEmitter.emit("issue:done", issue.id, [`https://github.com/acme/webapp/pull/${90 + i}`]);
		await sleep(800);
	}

	kanbanEmitter.emit("work:complete", { total: 4, duration: 185000 });
	await sleep(4000);
	kanbanEmitter.emit("tui:exit");
}
