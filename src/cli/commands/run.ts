import { resolve } from "node:path";
import { defineCommand } from "citty";
import pc from "picocolors";
import { configExists, loadConfig, mergeWithFlags } from "../../config.js";
import { runDemoLoop, runLoop } from "../../loop/index.js";
import { banner, setOutputMode, updateNotice } from "../../output/logger.js";
import { createKanbanPersistence } from "../../session/kanban-persistence.js";
import type { LifecycleMode, PRPlatform, ProviderName, SourceName } from "../../types/index.js";
import { getCachedUpdateInfo } from "../../version.js";
import { getMissingEnvVars } from "../detection.js";

export const run = defineCommand({
	meta: {
		name: "run",
		description: "Fetch issues, run AI agents, and deliver pull requests",
	},
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
		provider: {
			type: "string",
			description: "AI provider (claude, gemini, opencode, copilot, cursor, goose, aider, codex)",
		},
		source: {
			type: "string",
			description:
				"Issue source (linear, trello, plane, shortcut, gitlab-issues, github-issues, jira)",
		},
		label: { type: "string", description: "Label to filter issues" },
		platform: { type: "string", description: "PR platform: cli, token, gitlab, or bitbucket" },
		json: {
			type: "boolean",
			description: "Output machine-readable JSON (use with --dry-run)",
			default: false,
		},
	},
	async run({ args }) {
		const argv = process.argv.slice(2);

		// Validate flags: reject unknown flags to prevent typos from silently executing the loop.
		// Includes hidden flags (--lifecycle, --lifecycle-timeout, --demo) that are intentionally
		// omitted from --help but still accepted.
		const knownFlags = new Set([
			"run",
			"--once",
			"--watch",
			"-w",
			"--limit",
			"--bell",
			"--no-bell",
			"--concurrency",
			"-c",
			"--dry-run",
			"--issue",
			"--provider",
			"--source",
			"--label",
			"--platform",
			"--lifecycle",
			"--lifecycle-timeout",
			"--demo",
			"--json",
			"--help",
			"-h",
		]);
		for (const arg of argv) {
			if (arg.startsWith("-") && !arg.startsWith("--no-") && !knownFlags.has(arg.split("=")[0]!)) {
				console.error(pc.red(`Unknown flag: ${arg}`));
				console.error(pc.dim("Run `lisa run --help` to see available options."));
				process.exit(1);
			}
		}

		// Hidden flags: accessible but not shown in --help
		const lifecycleIdx = argv.indexOf("--lifecycle");
		const lifecycleValue = lifecycleIdx !== -1 ? argv[lifecycleIdx + 1] : undefined;
		const lifecycleTimeoutIdx = argv.indexOf("--lifecycle-timeout");
		const lifecycleTimeoutValue =
			lifecycleTimeoutIdx !== -1 ? argv[lifecycleTimeoutIdx + 1] : undefined;
		const isDemo = argv.includes("--demo");

		const isTTY = !!process.stdout.isTTY;

		setOutputMode(isTTY ? "tui" : "default");

		banner(); // no-op in tui mode since outputMode !== "default"

		// Show update notification in default (non-TUI) mode
		const updateInfo = getCachedUpdateInfo();
		if (updateInfo) {
			updateNotice(updateInfo);
		}

		if (isDemo) {
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
						scope: "Engineering",
						project: "Web App",
						label: "ready",
						pick_from: "Backlog",
						in_progress: "In Progress",
						done: "Done",
					},
					provider_options: {
						claude: { models: ["claude-sonnet-4-6"] },
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
		// Inject Goose provider from config into process.env if not already set
		if (merged.provider === "goose") {
			const gooseProvider = merged.provider_options?.goose?.goose_provider;
			if (gooseProvider && !process.env.GOOSE_PROVIDER) {
				process.env.GOOSE_PROVIDER = gooseProvider;
			}
		}

		// Apply lifecycle overrides from CLI flags
		if (lifecycleValue || lifecycleTimeoutValue) {
			const lifecycleTimeout = lifecycleTimeoutValue
				? Number.parseInt(lifecycleTimeoutValue, 10)
				: undefined;
			merged.lifecycle = {
				...merged.lifecycle,
				...(lifecycleValue && {
					mode: lifecycleValue as LifecycleMode,
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

		if (args["dry-run"] && args.json) {
			console.log(
				JSON.stringify(
					{
						provider: merged.provider,
						source: merged.source,
						platform: merged.platform,
						workflow: merged.workflow,
						label: merged.source_config.label,
						models: merged.provider_options?.[merged.provider]?.models ?? [],
						workspace: merged.workspace,
						base_branch: merged.base_branch,
						concurrency,
					},
					null,
					2,
				),
			);
			return;
		}

		// Force worktree mode when concurrency > 1 (parallel issues need isolation)
		if (concurrency > 1 && merged.workflow !== "worktree") {
			merged.workflow = "worktree";
		}

		let onBeforeExit: (() => void) | undefined;
		let persistedCards:
			| Array<{
					id: string;
					column: string;
					hasError?: boolean;
					skipped?: boolean;
					killed?: boolean;
			  }>
			| undefined;

		if (isTTY) {
			const workspace = resolve(merged.workspace);
			const persistence = createKanbanPersistence(workspace);
			const initialCards = persistence.load();
			persistedCards = initialCards;
			persistence.start();
			onBeforeExit = () => persistence.stop();

			const { render } = await import("ink");
			const { createElement } = await import("react");
			const { KanbanApp } = await import("../../ui/kanban.js");
			render(createElement(KanbanApp, { config: merged, initialCards }), { exitOnCtrlC: false });
		}

		await runLoop(merged, {
			once: args.once || !!args.issue,
			watch: args.watch,
			limit: Number.parseInt(args.limit, 10),
			dryRun: args["dry-run"],
			issueId: args.issue,
			concurrency,
			onBeforeExit,
			initialCards: persistedCards,
		});
	},
});
