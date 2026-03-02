import { defineCommand } from "citty";
import pc from "picocolors";
import { configExists, loadConfig, mergeWithFlags } from "../../config.js";
import { runDemoLoop, runLoop } from "../../loop/index.js";
import { banner, setOutputMode } from "../../output/logger.js";
import type { LifecycleMode, PRPlatform, ProviderName, SourceName } from "../../types/index.js";
import { getMissingEnvVars } from "../detection.js";

export const run = defineCommand({
	meta: { name: "run", description: "Run the agent loop" },
	args: {
		once: { type: "boolean", description: "Run a single iteration", default: false },
		watch: {
			type: "boolean",
			alias: "w",
			description: "Keep running after queue empties — poll for new issues every 60s",
			default: false,
		},
		limit: { type: "string", description: "Max number of issues to process", default: "0" },
		bell: {
			type: "boolean",
			description: "Enable terminal bell on issue completion/failure (use --no-bell to disable)",
			default: true,
		},
		concurrency: {
			type: "string",
			alias: "c",
			description: "Number of issues to process in parallel (default: 1)",
			default: "1",
		},
		"dry-run": {
			type: "boolean",
			description: "Preview config without executing — recommended first step to verify setup",
			default: false,
		},
		issue: { type: "string", description: "Run a specific issue by identifier or URL" },
		provider: { type: "string", description: "AI provider (claude, gemini, opencode)" },
		source: { type: "string", description: "Issue source (linear, trello)" },
		label: { type: "string", description: "Label to filter issues" },
		platform: { type: "string", description: "PR platform: cli, token, gitlab, or bitbucket" },
		lifecycle: {
			type: "string",
			description: "Lifecycle mode: auto | skip | validate-only",
		},
		"lifecycle-timeout": {
			type: "string",
			description: "Startup timeout per resource in seconds (default: 30)",
		},
		demo: {
			type: "boolean",
			description: "Run an animated demo of the kanban UI with fake issues",
			default: false,
		},
	},
	async run({ args }) {
		const isTTY = !!process.stdout.isTTY;

		setOutputMode(isTTY ? "tui" : "default");

		banner(); // no-op in tui mode since outputMode !== "default"

		if (args.demo) {
			if (isTTY) {
				const { render } = await import("ink");
				const { createElement } = await import("react");
				const { KanbanApp } = await import("../../ui/kanban.js");
				const demoConfig = {
					provider: "claude" as const,
					source: "linear" as const,
					workflow: "worktree" as const,
					platform: "cli" as const,
					source_config: {
						team: "Engineering",
						project: "Web App",
						label: "ready",
						pick_from: "Ready",
						in_progress: "In Progress",
						done: "Done",
					},
					loop: { cooldown: 30 },
					bell: false,
				};
				render(createElement(KanbanApp, { config: demoConfig as never }), { exitOnCtrlC: false });
			}
			await runDemoLoop();
			return;
		}

		if (!configExists()) {
			console.error(pc.red("No configuration found. Run `lisa init` first."));
			process.exit(1);
		}

		const config = loadConfig();
		const merged = mergeWithFlags(config, {
			provider: args.provider as ProviderName | undefined,
			source: args.source as SourceName | undefined,
			platform: args.platform as PRPlatform | undefined,
			label: args.label,
			bell: args.bell,
		});
		// Apply lifecycle overrides from CLI flags
		if (args.lifecycle || args["lifecycle-timeout"]) {
			const lifecycleTimeout = args["lifecycle-timeout"]
				? Number.parseInt(args["lifecycle-timeout"], 10)
				: undefined;
			merged.lifecycle = {
				...merged.lifecycle,
				...(args.lifecycle && {
					mode: args.lifecycle as LifecycleMode,
				}),
				...(lifecycleTimeout !== undefined &&
					!Number.isNaN(lifecycleTimeout) && {
						timeout: lifecycleTimeout,
					}),
			};
		}
		// Validate env vars before running
		const missingVars = await getMissingEnvVars(merged.source);
		if (missingVars.length > 0) {
			const shell = process.env.SHELL?.includes("zsh") ? "~/.zshrc" : "~/.bashrc";
			console.error(
				pc.red(
					`Missing required environment variables:\n${missingVars.map((v) => `  ${v}`).join("\n")}`,
				),
			);
			console.error(pc.dim(`\nAdd them to your ${shell} and run: source ${shell}`));
			process.exit(1);
		}

		const concurrency = Math.max(1, Number.parseInt(args.concurrency, 10) || 1);

		// Force worktree mode when concurrency > 1 (parallel issues need isolation)
		if (concurrency > 1 && merged.workflow !== "worktree") {
			merged.workflow = "worktree";
		}

		if (isTTY) {
			const { render } = await import("ink");
			const { createElement } = await import("react");
			const { KanbanApp } = await import("../../ui/kanban.js");
			render(createElement(KanbanApp, { config: merged }), { exitOnCtrlC: false });
		}

		await runLoop(merged, {
			once: args.once || !!args.issue,
			watch: args.watch,
			limit: Number.parseInt(args.limit, 10),
			dryRun: args["dry-run"],
			issueId: args.issue,
			concurrency,
		});
	},
});
