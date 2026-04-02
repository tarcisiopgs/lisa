import { resolve as resolvePath } from "node:path";
import * as clack from "@clack/prompts";
import pc from "picocolors";
import { saveConfig } from "../config.js";
import { isGhCliAvailable } from "../git/github.js";
import { listPlatformContributors } from "../git/platform.js";
import { ensureWorktreeGitignore } from "../git/worktree.js";
import { getAllProvidersWithAvailability } from "../providers/index.js";
import { createSource } from "../sources/index.js";
import { getTemplateById, getTemplates, templateToPartialConfig } from "../templates.js";
import type {
	LisaConfig,
	PRPlatform,
	ProviderName,
	SourceName,
	WorkflowMode,
} from "../types/index.js";
import {
	detectDefaultBranch,
	detectGitRepos,
	detectPlatform,
	fetchCopilotModels,
	fetchCursorModels,
	fetchOpenCodeModels,
	getMissingEnvVars,
	isCursorFreePlan,
} from "./detection.js";

async function selectOrInput(opts: {
	listFn?: () => Promise<{ value: string; label: string }[]>;
	message: string;
	placeholder?: string;
	initialValue?: string;
	multi?: boolean;
	spinnerMessage?: string;
}): Promise<string | string[]> {
	if (opts.listFn) {
		const spinner = clack.spinner();
		spinner.start(opts.spinnerMessage ?? "Fetching options...");
		try {
			const items = await Promise.race([
				opts.listFn(),
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
			]);
			spinner.stop(pc.dim(`Found ${items.length} options`));

			if (items.length > 0) {
				if (opts.multi) {
					const selected = await clack.multiselect({
						message: opts.message,
						options: items.map((i) => ({ value: i.value, label: i.label })),
						required: false,
					});
					if (clack.isCancel(selected)) return process.exit(0);
					return selected as string[];
				}
				const selected = await clack.select({
					message: opts.message,
					initialValue: opts.initialValue,
					options: items.map((i) => ({ value: i.value, label: i.label })),
				});
				if (clack.isCancel(selected)) return process.exit(0);
				return selected as string;
			}
		} catch {
			spinner.stop(pc.yellow("Could not fetch options — entering manually"));
		}
	}

	// Fallback to text input
	const answer = await clack.text({
		message: opts.message,
		initialValue: opts.initialValue ?? "",
		placeholder: opts.placeholder,
	});
	if (clack.isCancel(answer)) return process.exit(0);
	return answer as string;
}

export async function runConfigWizard(existing?: LisaConfig): Promise<void> {
	clack.intro(
		pc.cyan(
			existing ? " lisa \u266a  editing config " : " lisa \u266a  autonomous issue resolver ",
		),
	);

	const providerLabels: Record<ProviderName, string> = {
		claude: "Claude Code",
		gemini: "Gemini CLI",
		opencode: "OpenCode",
		copilot: "GitHub Copilot CLI",
		cursor: "Cursor Agent",
		goose: "Goose",
		aider: "Aider",
		codex: "OpenAI Codex",
	};

	const providerModels: Partial<Record<ProviderName, string[]>> = {
		claude: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5", "claude-sonnet-4-5"],
		gemini: [
			"gemini-3.1-pro-preview",
			"gemini-3-pro-preview",
			"gemini-3-flash-preview",
			"gemini-2.5-pro",
			"gemini-2.5-flash",
			"gemini-2.5-flash-lite",
		],
		// opencode: populated dynamically below (fetchOpenCodeModels)
		// copilot: populated from static list below (fetchCopilotModels)
		// goose: populated per backend below
		// aider: populated per available API keys below
		codex: [
			"gpt-5.3-codex",
			"gpt-5.2-codex",
			"gpt-5.2",
			"gpt-5.1-codex-max",
			"gpt-5.1-codex-mini",
			"gpt-5.4",
		],
		// cursor: populated dynamically below (fetchCursorModels)
	};

	const allProviders = await getAllProvidersWithAvailability();
	const available = allProviders.filter((r) => r.available).map((r) => r.provider);

	if (available.length === 0) {
		clack.log.error("No AI provider found on your system.");
		clack.log.info(
			`Install at least one of the following and re-run ${pc.cyan("lisa init")}:\n\n` +
				`  ${pc.bold("Claude Code")}        ${pc.dim("npm i -g @anthropic-ai/claude-code")}\n` +
				`  ${pc.bold("Gemini CLI")}         ${pc.dim("npm i -g @google/gemini-cli")}\n` +
				`  ${pc.bold("OpenCode")}           ${pc.dim("npm i -g opencode")}\n` +
				`  ${pc.bold("GitHub Copilot CLI")} ${pc.dim("npm i -g @github/copilot-cli")}\n` +
				`  ${pc.bold("OpenAI Codex")}       ${pc.dim("npm i -g @openai/codex")}\n` +
				`  ${pc.bold("Goose")}              ${pc.dim("https://block.github.io/goose")}\n` +
				`  ${pc.bold("Aider")}              ${pc.dim("pip install aider-chat")}`,
		);
		return process.exit(1);
	}

	// Template selection: offer pre-defined configs for common source+provider combos
	let templateDefaults: LisaConfig | undefined;
	if (!existing) {
		const applicableTemplates = getTemplates().filter((t) =>
			available.some((p) => p.name === t.provider),
		);
		if (applicableTemplates.length > 0) {
			const templateChoice = await clack.select({
				message: "Start with a template or configure manually?",
				options: [
					...applicableTemplates.map((t) => ({
						value: t.id,
						label: t.label,
						hint: t.hint,
					})),
					{ value: "custom", label: "Configure manually", hint: "full wizard" },
				],
			});
			if (clack.isCancel(templateChoice)) return process.exit(0);
			if (templateChoice !== "custom") {
				const template = getTemplateById(templateChoice as string);
				if (template) {
					templateDefaults = templateToPartialConfig(template);
					clack.log.info(`Template applied: ${pc.bold(template.label)}`);
				}
			}
		}
	}

	const initial = existing ?? templateDefaults;

	let providerName: ProviderName;

	if (available.length === 1 && available[0] && !initial) {
		providerName = available[0].name;
		clack.log.info(`Auto-detected ${pc.bold(providerLabels[providerName])} as your AI provider.`);
	} else {
		const selected = await clack.select({
			message: "Which AI provider should resolve your issues?",
			initialValue: initial?.provider,
			options: allProviders.map(({ provider, available: isAvailable }) => ({
				value: provider.name,
				label: providerLabels[provider.name],
				hint: isAvailable ? undefined : "not installed",
				disabled: !isAvailable,
			})),
		});
		if (clack.isCancel(selected)) return process.exit(0);
		providerName = selected as ProviderName;
	}

	// Provider-specific setup hints / interactive config
	let gooseProvider: string | undefined;
	if (providerName === "goose") {
		const gooseProviderAnswer = await clack.select({
			message: "Which backend should Goose use?",
			initialValue:
				initial?.provider_options?.goose?.goose_provider ??
				process.env.GOOSE_PROVIDER ??
				"gemini-cli",
			options: [
				{ value: "gemini-cli", label: "Gemini CLI", hint: "requires Gemini CLI installed" },
				{ value: "anthropic", label: "Anthropic", hint: "requires ANTHROPIC_API_KEY" },
				{ value: "openai", label: "OpenAI", hint: "requires OPENAI_API_KEY" },
				{ value: "google", label: "Google (direct)", hint: "requires GOOGLE_API_KEY" },
				{ value: "ollama", label: "Ollama", hint: "local models" },
			],
		});
		if (clack.isCancel(gooseProviderAnswer)) return process.exit(0);
		gooseProvider = gooseProviderAnswer as string;
	} else if (providerName === "aider") {
		clack.log.info(
			`Aider requires a direct LLM API key in your environment.\n` +
				`Set one of: ${pc.bold("GEMINI_API_KEY")}, ${pc.bold("OPENAI_API_KEY")}, ${pc.bold("ANTHROPIC_API_KEY")}, etc.\n` +
				`Aider does not use OAuth or cached credentials.`,
		);
	} else if (providerName === "opencode") {
		clack.log.info(
			`OpenCode tip: if you have MCP entries in ${pc.cyan("~/.config/opencode/config.json")},\n` +
				`remove them or set the file to ${pc.cyan("{}")} — MCP tools can cause OpenCode to hang.`,
		);
	}

	let selectedModels: string[] = [];

	let availableModels = providerModels[providerName];

	if (providerName === "goose" && gooseProvider) {
		const gooseModelsByBackend: Record<string, string[]> = {
			"gemini-cli": ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro"],
			anthropic: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5", "claude-sonnet-4-5"],
			openai: ["gpt-5.2", "gpt-5.1", "gpt-4.1", "o4-mini", "o3"],
			google: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite"],
			ollama: ["llama3.3", "qwen2.5-coder", "mistral"],
		};
		availableModels = gooseModelsByBackend[gooseProvider] ?? [];
	} else if (providerName === "aider") {
		// Aider uses direct API keys — show models matching the user's available keys
		const aiderModels: string[] = [];
		if (process.env.ANTHROPIC_API_KEY) {
			aiderModels.push(
				"anthropic/claude-opus-4-6",
				"anthropic/claude-sonnet-4-6",
				"anthropic/claude-haiku-4-5",
			);
		}
		if (process.env.OPENAI_API_KEY) {
			aiderModels.push("openai/gpt-5.2", "openai/gpt-4o", "openai/o4-mini", "openai/o3");
		}
		if (process.env.GEMINI_API_KEY) {
			aiderModels.push(
				"gemini/gemini-2.5-pro",
				"gemini/gemini-2.5-flash",
				"gemini/gemini-2.5-flash-lite",
			);
		}
		if (aiderModels.length === 0) {
			clack.log.warning(
				"No API key found for Aider. Set one of: ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY",
			);
		}
		availableModels = aiderModels;
	} else if (providerName === "copilot") {
		availableModels = fetchCopilotModels();
	} else if (providerName === "cursor") {
		const isFree = await isCursorFreePlan();
		if (isFree) {
			availableModels = ["auto"];
			clack.log.info("Cursor Free plan detected — only the 'auto' model is available.");
		} else {
			availableModels = fetchCursorModels();
		}
	} else if (providerName === "opencode") {
		const dynamic = fetchOpenCodeModels();
		availableModels =
			dynamic.length > 0
				? dynamic
				: [
						"anthropic/claude-opus-4-6",
						"anthropic/claude-sonnet-4-6",
						"anthropic/claude-haiku-4-5",
						"google/gemini-3.1-pro-preview",
						"google/gemini-3-pro-preview",
						"google/gemini-2.5-pro",
						"google/gemini-2.5-flash",
					];
	}

	if (availableModels && availableModels.length > 0) {
		const modelSelection = await clack.multiselect({
			message: "Which models should Lisa use? Select in order — first = primary, rest = fallbacks",
			initialValues:
				initial?.provider_options?.[providerName]?.models?.filter((m: string) =>
					availableModels.includes(m),
				) ?? [],
			options: availableModels.map((m) => ({
				value: m,
				label: m,
			})),
			required: false,
		});
		if (clack.isCancel(modelSelection)) return process.exit(0);
		selectedModels = (modelSelection as string[]) ?? [];
	}

	const ghCliAvailable = await isGhCliAvailable();
	const source = await clack.select({
		message: "Where do your issues come from?",
		initialValue: initial?.source,
		options: (
			[
				{
					value: "linear",
					label: "Linear",
					apiHint: "GraphQL API",
					envVars: ["LINEAR_API_KEY"],
					ghCliFallback: false,
				},
				{
					value: "trello",
					label: "Trello",
					apiHint: "REST API",
					envVars: ["TRELLO_API_KEY", "TRELLO_TOKEN"],
					ghCliFallback: false,
				},
				{
					value: "github-issues",
					label: "GitHub Issues",
					apiHint: "REST API",
					envVars: ["GITHUB_TOKEN"],
					ghCliFallback: true,
				},
				{
					value: "gitlab-issues",
					label: "GitLab Issues",
					apiHint: "REST API",
					envVars: ["GITLAB_TOKEN"],
					ghCliFallback: false,
				},
				{
					value: "plane",
					label: "Plane",
					apiHint: "REST API",
					envVars: ["PLANE_API_TOKEN"],
					ghCliFallback: false,
				},
				{
					value: "shortcut",
					label: "Shortcut",
					apiHint: "REST API",
					envVars: ["SHORTCUT_API_TOKEN"],
					ghCliFallback: false,
				},
				{
					value: "jira",
					label: "Jira",
					apiHint: "REST API",
					envVars: ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"],
					ghCliFallback: false,
				},
			] as const
		).map(({ value, label, apiHint, envVars, ghCliFallback }) => {
			let missing = envVars.filter((v) => !process.env[v]);
			if (ghCliFallback && ghCliAvailable) {
				missing = missing.filter((v) => v !== "GITHUB_TOKEN");
			}
			const usingGhCli = ghCliFallback && ghCliAvailable && !process.env.GITHUB_TOKEN;
			return {
				value,
				label,
				hint:
					missing.length > 0
						? `missing: ${missing.join(", ")}`
						: usingGhCli
							? "via gh CLI"
							: apiHint,
				disabled: missing.length > 0,
			};
		}),
	});
	if (clack.isCancel(source)) return process.exit(0);

	// Validate env vars for the selected source
	const missing = await getMissingEnvVars(source as SourceName);
	if (missing.length > 0) {
		const shell = process.env.SHELL?.includes("zsh") ? "~/.zshrc" : "~/.bashrc";
		clack.log.warning(
			`The following environment variables are missing:\n\n` +
				`${missing.map((v) => `  ${pc.bold(v)}`).join("\n")}\n\n` +
				`Add them to ${pc.cyan(shell)}:\n` +
				`${missing.map((v) => `  export ${v}="your-value-here"`).join("\n")}\n\n` +
				`Then reload: ${pc.cyan(`source ${shell}`)}`,
		);
	}

	// Detect platform
	const platform = await detectPlatform();

	// --- Issue source config (API-driven where possible) ---

	const sourceKey = source as SourceName;
	const sourceInstance = createSource(sourceKey);

	// Scope
	let scope: string;
	if (sourceKey === "shortcut") {
		scope = "";
		clack.log.info("Shortcut workspace is determined by your API token — no scope needed.");
	} else {
		scope = (await selectOrInput({
			listFn: sourceInstance.listScopes?.bind(sourceInstance),
			message:
				sourceKey === "linear"
					? "What is your Linear team name?"
					: sourceKey === "trello"
						? "Which Trello board?"
						: sourceKey === "jira"
							? "Which Jira project?"
							: sourceKey === "plane"
								? "What is your Plane workspace slug?"
								: sourceKey === "github-issues"
									? "Which GitHub repository? (owner/repo)"
									: sourceKey === "gitlab-issues"
										? "Which GitLab project? (namespace/project)"
										: "What is your scope?",
			placeholder:
				sourceKey === "linear"
					? "e.g. Engineering"
					: sourceKey === "github-issues"
						? "e.g. owner/repo"
						: sourceKey === "gitlab-issues"
							? "e.g. namespace/project"
							: undefined,
			initialValue: initial?.source_config.scope ?? "",
			spinnerMessage:
				sourceKey === "trello"
					? "Fetching boards..."
					: sourceKey === "jira"
						? "Fetching projects..."
						: "Fetching...",
		})) as string;
	}

	// Project (non-Trello sources)
	let project: string;
	if (sourceKey === "trello") {
		project = "";
	} else {
		project = (await selectOrInput({
			listFn: sourceInstance.listProjects ? () => sourceInstance.listProjects!(scope) : undefined,
			message:
				sourceKey === "linear"
					? "Which Linear project? (leave empty for all team issues)"
					: "Which project?",
			initialValue: initial?.source_config.project ?? "",
			placeholder: sourceKey === "linear" ? "e.g. Q1 Roadmap  (optional)" : undefined,
			spinnerMessage: "Fetching projects...",
		})) as string;
	}

	// Labels
	const initialLabelStr = initial
		? Array.isArray(initial.source_config.label)
			? initial.source_config.label.join(", ")
			: initial.source_config.label
		: "";
	const labelValue = await selectOrInput({
		listFn: sourceInstance.listLabels
			? () => sourceInstance.listLabels!(scope, project)
			: undefined,
		message: "Which label(s) mark issues as ready?",
		multi: true,
		initialValue: initialLabelStr || "ready",
		placeholder: "e.g. ready  or  ready, api",
		spinnerMessage: "Fetching labels...",
	});

	const labelParts = Array.isArray(labelValue)
		? labelValue
		: (labelValue as string)
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
	const label: string | string[] = labelParts.length === 1 ? (labelParts[0] as string) : labelParts;

	let removeLabel: string | undefined;
	if (Array.isArray(label) && label.length > 1) {
		const removeLabelAnswer = await clack.text({
			message:
				"Which label should be removed when an issue is completed? (required for multi-label)",
			initialValue: initial?.source_config.remove_label ?? label[0] ?? "",
			placeholder: `e.g. ${label[0]}`,
		});
		if (clack.isCancel(removeLabelAnswer)) return process.exit(0);
		removeLabel = (removeLabelAnswer as string) || undefined;
	}

	// Statuses
	const isLabelBasedSource = sourceKey === "github-issues" || sourceKey === "gitlab-issues";
	const statusListFn = sourceInstance.listStatuses
		? () => sourceInstance.listStatuses!(scope, project)
		: undefined;

	let pickFrom: string;
	let inProgress: string;
	let done: string;

	if (sourceKey === "trello") {
		pickFrom = (await selectOrInput({
			listFn: statusListFn,
			message: "Pick up cards from which list?",
			initialValue: initial?.source_config.pick_from ?? "Backlog",
			spinnerMessage: "Fetching lists...",
		})) as string;
		project = pickFrom;

		inProgress = (await selectOrInput({
			listFn: statusListFn,
			message: "Move the card to which list while the agent is working?",
			initialValue: initial?.source_config.in_progress ?? "In Progress",
			spinnerMessage: "Fetching lists...",
		})) as string;

		done = (await selectOrInput({
			listFn: statusListFn,
			message: "Move the card to which list after the PR is created?",
			initialValue: initial?.source_config.done ?? "Code Review",
			spinnerMessage: "Fetching lists...",
		})) as string;
	} else {
		pickFrom = (await selectOrInput({
			listFn: statusListFn,
			message: isLabelBasedSource
				? "Pick up issues in which state? (open, closed, or a label name)"
				: "Pick up issues in which status?",
			initialValue: initial?.source_config.pick_from ?? (isLabelBasedSource ? "open" : "Backlog"),
			placeholder: isLabelBasedSource ? "e.g. open" : "e.g. Backlog, Todo",
			spinnerMessage: "Fetching statuses...",
		})) as string;

		inProgress = (await selectOrInput({
			listFn: statusListFn,
			message: isLabelBasedSource
				? "Which label to apply while the agent is working?"
				: "Move to which status while the agent is working?",
			initialValue: initial?.source_config.in_progress ?? "In Progress",
			placeholder: isLabelBasedSource ? "e.g. in-progress" : undefined,
			spinnerMessage: "Fetching statuses...",
		})) as string;

		if (isLabelBasedSource && inProgress === pickFrom) {
			clack.log.warning(
				`"in_progress" label is the same as "pick_from" label ("${pickFrom}").\n` +
					`This will cause Lisa to re-pick the issue on recovery. Consider using a different label.`,
			);
		}

		done = (await selectOrInput({
			listFn: statusListFn,
			message: isLabelBasedSource
				? "Which label to apply after the PR is created?"
				: "Move to which status after the PR is created?",
			initialValue: initial?.source_config.done ?? "In Review",
			spinnerMessage: "Fetching statuses...",
		})) as string;
	}

	// --- Git workflow ---

	const workflowAnswer = await clack.select({
		message: "How should Lisa check out code for each issue?",
		initialValue: initial?.workflow,
		options: [
			{
				value: "worktree",
				label: "Worktree",
				hint: "isolated git worktree per issue — recommended",
			},
			{
				value: "branch",
				label: "Branch",
				hint: "new branch in the current checkout",
			},
		],
	});
	if (clack.isCancel(workflowAnswer)) return process.exit(0);
	const workflow = workflowAnswer as WorkflowMode;

	// Auto-detect repos
	const repos = await detectGitRepos(initial?.repos ?? []);

	// Ask for base branch
	let baseBranch = "main";
	const cwd = process.cwd();

	if (repos.length === 0) {
		const detected = initial?.base_branch ?? detectDefaultBranch(cwd);
		const branchAnswer = await clack.text({
			message: "What is the base branch to branch off from?",
			initialValue: detected,
		});
		if (clack.isCancel(branchAnswer)) return process.exit(0);
		baseBranch = branchAnswer as string;
	} else {
		for (const repo of repos) {
			const repoPath = resolvePath(cwd, repo.path);
			const detected = detectDefaultBranch(repoPath);
			const branchAnswer = await clack.text({
				message: `Base branch for ${pc.bold(repo.name)}?`,
				initialValue: detected,
			});
			if (clack.isCancel(branchAnswer)) return process.exit(0);
			repo.base_branch = branchAnswer as string;
		}
	}

	// Setup .worktrees gitignore if worktree mode
	if (workflow === "worktree") {
		if (repos.length === 0) {
			ensureWorktreeGitignore(cwd);
		} else {
			for (const repo of repos) {
				ensureWorktreeGitignore(resolvePath(cwd, repo.path));
			}
		}
		clack.log.info("Added .worktrees/ to .gitignore");
	}

	// Review monitor — only for GitHub platforms
	let reviewMonitorEnabled = false;
	if (platform === "cli" || platform === "token") {
		const enableReviewMonitor = await clack.confirm({
			message: "Enable post-PR review monitoring? (auto-addresses reviewer feedback)",
			initialValue: initial?.review_monitor?.enabled ?? false,
		});
		if (clack.isCancel(enableReviewMonitor)) return process.exit(0);
		reviewMonitorEnabled = enableReviewMonitor as boolean;
	}

	// --- PR reviewers ---
	let prReviewers: string[] = [];
	const wantReviewers = await clack.confirm({
		message: "Configure default PR reviewers?",
		initialValue: !!initial?.pr?.reviewers?.length,
	});
	if (clack.isCancel(wantReviewers)) return process.exit(0);

	if (wantReviewers) {
		const listFn = async (): Promise<{ value: string; label: string }[]> => {
			const contributors = await listPlatformContributors(platform as PRPlatform, process.cwd());
			return contributors.map((c) => ({ value: c, label: c }));
		};

		const reviewerValue = await selectOrInput({
			listFn,
			message: "Who should review PRs? (select contributors or type usernames)",
			multi: true,
			initialValue: initial?.pr?.reviewers?.join(", ") ?? "",
			placeholder: "e.g. alice, bob",
			spinnerMessage: "Fetching repository contributors...",
		});

		prReviewers = Array.isArray(reviewerValue)
			? reviewerValue
			: (reviewerValue as string)
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean);
	}

	const cfg: LisaConfig = {
		provider: providerName,
		provider_options: {
			...(initial?.provider_options || {}),
			[providerName]: {
				models: selectedModels,
				...(gooseProvider ? { goose_provider: gooseProvider } : {}),
			},
		},
		source: source as SourceName,
		source_config: {
			scope,
			project,
			label,
			...(removeLabel ? { remove_label: removeLabel } : {}),
			pick_from: pickFrom,
			in_progress: inProgress,
			done,
		},
		platform,
		workflow,
		workspace: ".",
		base_branch: baseBranch,
		repos,
		loop: { cooldown: 10, max_sessions: 0 },
		...(reviewMonitorEnabled ? { review_monitor: { enabled: true } } : {}),
		...(prReviewers.length ? { pr: { reviewers: prReviewers } } : {}),
	};

	saveConfig(cfg);
	clack.outro(
		`${pc.green("All set!")} Config saved to ${pc.cyan(".lisa/config.yaml")}\n` +
			`  Run ${pc.bold(pc.cyan("lisa run"))} to start resolving issues.`,
	);
}
