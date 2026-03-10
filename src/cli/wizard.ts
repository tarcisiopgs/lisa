import { resolve as resolvePath } from "node:path";
import * as clack from "@clack/prompts";
import pc from "picocolors";
import { saveConfig } from "../config.js";
import { isGhCliAvailable } from "../git/github.js";
import { ensureWorktreeGitignore } from "../git/worktree.js";
import { getAllProvidersWithAvailability } from "../providers/index.js";
import { getTemplateById, getTemplates, templateToPartialConfig } from "../templates.js";
import type { LisaConfig, ProviderName, SourceName, WorkflowMode } from "../types/index.js";
import {
	detectDefaultBranch,
	detectGitRepos,
	detectPlatform,
	fetchCursorModels,
	fetchOpenCodeModels,
	getMissingEnvVars,
	isCursorFreePlan,
} from "./detection.js";

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
		copilot: ["claude-opus-4.6", "claude-sonnet-4.6", "claude-haiku-4.5", "gpt-5.2"],
		goose: ["claude-sonnet-4-5", "claude-opus-4-5", "claude-haiku-4-5"],
		aider: ["claude-opus-4-6", "claude-sonnet-4-5", "claude-haiku-4-5"],
		codex: ["gpt-5.1-codex-mini", "gpt-5.1-codex-max", "gpt-5.2-codex", "gpt-5.2", "gpt-5.3-codex"],
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
			"gemini-cli": [
				"gemini-2.5-pro",
				"gemini-2.5-flash",
				"gemini-2.0-flash",
				"gemini-2.5-flash-lite",
			],
			anthropic: ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5", "claude-sonnet-4-5"],
			openai: ["gpt-4o", "gpt-4o-mini", "o3", "o4-mini"],
			google: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"],
			ollama: ["llama3.3", "qwen2.5-coder", "mistral"],
		};
		availableModels = gooseModelsByBackend[gooseProvider] ?? [];
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

	// --- Issue source config ---

	const teamAnswer = await clack.text({
		message:
			source === "linear"
				? "What is your Linear team name?"
				: source === "trello"
					? "What is your Trello board name?"
					: source === "jira"
						? "What is your Jira project key?"
						: "What is your team or project name?",
		initialValue: initial?.source_config.team ?? "",
		placeholder: source === "linear" ? "e.g. Engineering" : undefined,
	});
	if (clack.isCancel(teamAnswer)) return process.exit(0);
	const team = teamAnswer as string;

	const initialLabelStr = initial
		? Array.isArray(initial.source_config.label)
			? initial.source_config.label.join(", ")
			: initial.source_config.label
		: "";
	const labelAnswer = await clack.text({
		message: "Which label(s) mark issues as ready? (comma-separated for multiple, e.g. ready,api)",
		initialValue: initialLabelStr || "ready",
		placeholder: "e.g. ready  or  ready, api",
	});
	if (clack.isCancel(labelAnswer)) return process.exit(0);
	const labelParts = (labelAnswer as string)
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

	let project: string;
	let pickFrom: string;
	let inProgress: string;
	let done: string;

	if (source === "trello") {
		const pickFromAnswer = await clack.text({
			message: "Pick up cards from which list?",
			initialValue: initial?.source_config.pick_from ?? "Backlog",
		});
		if (clack.isCancel(pickFromAnswer)) return process.exit(0);
		pickFrom = pickFromAnswer as string;
		project = pickFrom;

		const inProgressAnswer = await clack.text({
			message: "Move the card to which list while the agent is working?",
			initialValue: initial?.source_config.in_progress ?? "In Progress",
		});
		if (clack.isCancel(inProgressAnswer)) return process.exit(0);
		inProgress = inProgressAnswer as string;

		const doneAnswer = await clack.text({
			message: "Move the card to which list after the PR is created?",
			initialValue: initial?.source_config.done ?? "Code Review",
		});
		if (clack.isCancel(doneAnswer)) return process.exit(0);
		done = doneAnswer as string;
	} else {
		const projectAnswer = await clack.text({
			message:
				source === "linear"
					? "Which Linear project should Lisa work on? (leave empty for all team issues)"
					: "Which project should Lisa work on?",
			initialValue: initial?.source_config.project ?? "",
			placeholder: source === "linear" ? "e.g. Q1 Roadmap  (optional)" : undefined,
		});
		if (clack.isCancel(projectAnswer)) return process.exit(0);
		project = projectAnswer as string;

		const isLabelBasedSource = source === "github-issues" || source === "gitlab-issues";

		const pickFromAnswer = await clack.text({
			message: isLabelBasedSource
				? "Pick up issues in which state? (open, closed, or a label name)"
				: "Pick up issues in which status?",
			initialValue: initial?.source_config.pick_from ?? (isLabelBasedSource ? "open" : "Backlog"),
			placeholder: isLabelBasedSource ? "e.g. open" : "e.g. Backlog, Todo",
		});
		if (clack.isCancel(pickFromAnswer)) return process.exit(0);
		pickFrom = pickFromAnswer as string;
		const inProgressAnswer = await clack.text({
			message: isLabelBasedSource
				? "Which label to apply while the agent is working? (must differ from pick_from label)"
				: "Move to which status while the agent is working?",
			initialValue: initial?.source_config.in_progress ?? "In Progress",
			placeholder: isLabelBasedSource ? "e.g. in-progress" : undefined,
		});
		if (clack.isCancel(inProgressAnswer)) return process.exit(0);
		inProgress = inProgressAnswer as string;

		if (isLabelBasedSource && inProgress === pickFrom) {
			clack.log.warning(
				`"in_progress" label is the same as "pick_from" label ("${pickFrom}").\n` +
					`This will cause Lisa to re-pick the issue on recovery. Consider using a different label.`,
			);
		}

		const doneAnswer = await clack.text({
			message: isLabelBasedSource
				? "Which label to apply after the PR is created?"
				: "Move to which status after the PR is created?",
			initialValue: initial?.source_config.done ?? "In Review",
		});
		if (clack.isCancel(doneAnswer)) return process.exit(0);
		done = doneAnswer as string;
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
			team,
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
	};

	saveConfig(cfg);
	clack.outro(
		`${pc.green("All set!")} Config saved to ${pc.cyan(".lisa/config.yaml")}\n` +
			`  Run ${pc.bold(pc.cyan("lisa run"))} to start resolving issues.`,
	);
}
