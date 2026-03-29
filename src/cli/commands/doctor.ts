import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineCommand } from "citty";
import pc from "picocolors";
import { configExists, loadConfig, validateConfig } from "../../config.js";
import { formatError } from "../../errors.js";
import { isGhCliAvailable } from "../../git/github.js";
import { createProvider } from "../../providers/index.js";
import { isProofOfWorkEnabled } from "../../session/proof-of-work.js";
import { isSpecComplianceEnabled } from "../../session/spec-compliance.js";
import type { LisaConfig } from "../../types/index.js";
import { getMissingEnvVars } from "../detection.js";
import { CliError } from "../error.js";

interface CheckResult {
	passed: boolean;
	label: string;
	suggestion?: string;
	category: "core" | "advanced";
}

function checkCommandExists(command: string): boolean {
	try {
		execSync(`which ${command}`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
		return true;
	} catch {
		return false;
	}
}

function runAdvancedChecks(config: LisaConfig): CheckResult[] {
	const results: CheckResult[] = [];
	const workspace = resolve(config.workspace || process.cwd());

	// Proof of work: validate commands are accessible
	if (isProofOfWorkEnabled(config.proof_of_work)) {
		for (const cmd of config.proof_of_work?.commands ?? []) {
			const baseCmd = cmd.run.split(" ")[0] ?? "";
			// Check common patterns: npm/pnpm/yarn commands or direct binaries
			const isPackageScript = /^(npm|pnpm|yarn|npx|bun)\b/.test(cmd.run);
			if (isPackageScript) {
				const pmCmd = baseCmd;
				const pmAvailable = checkCommandExists(pmCmd);
				results.push({
					passed: pmAvailable,
					label: `Proof of work "${cmd.name}": ${pmCmd} is available`,
					suggestion: pmAvailable
						? undefined
						: `Install ${pmCmd} or update proof_of_work.commands.`,
					category: "advanced",
				});
			} else if (baseCmd) {
				const available = checkCommandExists(baseCmd);
				results.push({
					passed: available,
					label: `Proof of work "${cmd.name}": ${baseCmd} is available`,
					suggestion: available
						? undefined
						: `Command "${baseCmd}" not found. Check proof_of_work.commands.`,
					category: "advanced",
				});
			}
		}
	}

	// Spec compliance: flag if enabled
	if (isSpecComplianceEnabled(config.spec_compliance)) {
		results.push({
			passed: true,
			label: "Spec compliance is enabled",
			category: "advanced",
		});
	}

	// Plan validation: flag if enabled
	if (config.plan_validation?.enabled) {
		const maxIter = config.plan_validation.max_iterations ?? 2;
		results.push({
			passed: true,
			label: `Plan validation is enabled (max ${maxIter} iteration${maxIter !== 1 ? "s" : ""})`,
			category: "advanced",
		});
	}

	// Hooks: validate hook commands exist
	if (config.hooks) {
		for (const [name, cmd] of Object.entries(config.hooks)) {
			if (name === "timeout" || !cmd || typeof cmd !== "string") continue;
			const baseCmd = cmd.split(" ")[0] ?? "";
			if (baseCmd) {
				const available = checkCommandExists(baseCmd) || existsSync(resolve(workspace, baseCmd));
				results.push({
					passed: available,
					label: `Hook "${name}": ${baseCmd} is accessible`,
					suggestion: available
						? undefined
						: `Command "${baseCmd}" not found. Check hooks.${name} in config.`,
					category: "advanced",
				});
			}
		}
	}

	// Worktree mode: check git version supports worktrees
	if (config.workflow === "worktree") {
		try {
			const gitVersion = execSync("git --version", { encoding: "utf-8" }).trim();
			const versionMatch = /(\d+)\.(\d+)/.exec(gitVersion);
			const major = versionMatch?.[1] ? Number.parseInt(versionMatch[1], 10) : 0;
			const minor = versionMatch?.[2] ? Number.parseInt(versionMatch[2], 10) : 0;
			const supported = major > 2 || (major === 2 && minor >= 15);
			results.push({
				passed: supported,
				label: `Git worktree support (${gitVersion})`,
				suggestion: supported
					? undefined
					: "Git 2.15+ required for worktree mode. Update git or use workflow: branch.",
				category: "advanced",
			});
		} catch {
			results.push({
				passed: false,
				label: "Git worktree support",
				suggestion: "Could not determine git version.",
				category: "advanced",
			});
		}
	}

	// Multi-repo: check repo paths exist
	if (config.repos.length > 1) {
		for (const repo of config.repos) {
			const repoPath = resolve(workspace, repo.path);
			const repoExists = existsSync(repoPath);
			const hasGit = repoExists && existsSync(resolve(repoPath, ".git"));
			results.push({
				passed: repoExists && hasGit,
				label: `Repo "${repo.name}" exists at ${repo.path}`,
				suggestion:
					repoExists && hasGit
						? undefined
						: repoExists
							? `Path exists but is not a git repo. Check repos[].path.`
							: `Path "${repo.path}" does not exist. Check repos[].path.`,
				category: "advanced",
			});
		}
	}

	// Context file: check if .lisa/context.md exists
	const contextPath = resolve(workspace, ".lisa", "context.md");
	results.push({
		passed: existsSync(contextPath),
		label: "Project context file exists",
		suggestion: existsSync(contextPath)
			? undefined
			: 'Run "lisa context refresh" to generate .lisa/context.md for better planning.',
		category: "advanced",
	});

	// PR reviewers/assignees: check for platform incompatibilities
	if (config.pr) {
		if (config.platform === "bitbucket" && config.pr.assignees?.length) {
			results.push({
				passed: false,
				label: "PR assignees compatible with platform",
				suggestion:
					"Bitbucket does not support PR assignees. Remove pr.assignees or switch platform.",
				category: "advanced",
			});
		}
		if (config.pr.reviewers?.length || config.pr.assignees?.length) {
			results.push({
				passed: true,
				label: `PR config: ${config.pr.reviewers?.length ?? 0} reviewer(s), ${config.pr.assignees?.length ?? 0} assignee(s)`,
				category: "advanced",
			});
		}
	}

	return results;
}

export const doctor = defineCommand({
	meta: {
		name: "doctor",
		description:
			"Check your setup for common issues\n\n  Examples:\n    lisa doctor                        Run all diagnostic checks",
	},
	async run() {
		console.error("\nLisa Doctor\n");

		const results: CheckResult[] = [];

		// 1. Config file exists
		const hasConfig = configExists();
		results.push({
			passed: hasConfig,
			label: "Configuration file found",
			suggestion: 'Run "lisa init" to create a configuration file.',
			category: "core",
		});

		// 2. Config validation passes
		let config: LisaConfig | null = null;
		if (hasConfig) {
			try {
				config = loadConfig();
				validateConfig(config);
				results.push({ passed: true, label: "Configuration is valid", category: "core" });
			} catch (err) {
				const msg = formatError(err);
				results.push({
					passed: false,
					label: "Configuration is valid",
					suggestion: msg,
					category: "core",
				});
			}
		} else {
			results.push({
				passed: false,
				label: "Configuration is valid",
				suggestion: 'No configuration file found. Run "lisa init" first.',
				category: "core",
			});
		}

		// 3. Provider binary is installed
		if (config?.provider) {
			try {
				const provider = createProvider(config.provider);
				const available = await provider.isAvailable();
				results.push({
					passed: available,
					label: `Provider "${config.provider}" is installed`,
					suggestion: `Install it or change provider in .lisa/config.yaml`,
					category: "core",
				});
			} catch {
				results.push({
					passed: false,
					label: `Provider "${config.provider}" is installed`,
					suggestion: "Install it or change provider in .lisa/config.yaml",
					category: "core",
				});
			}
		} else {
			results.push({
				passed: false,
				label: "Provider is configured",
				suggestion: 'Set a provider in .lisa/config.yaml or run "lisa init".',
				category: "core",
			});
		}

		// 4. Required env vars for the configured source
		if (config?.source) {
			const missing = await getMissingEnvVars(config.source);
			if (missing.length === 0) {
				results.push({
					passed: true,
					label: `Source "${config.source}" environment variables are set`,
					category: "core",
				});
			} else {
				results.push({
					passed: false,
					label: `Source "${config.source}" environment variables are set`,
					suggestion: `Missing: ${missing.join(", ")}. Add them to your shell profile.`,
					category: "core",
				});
			}
		} else {
			results.push({
				passed: false,
				label: "Source is configured",
				suggestion: 'Set a source in .lisa/config.yaml or run "lisa init".',
				category: "core",
			});
		}

		// 5. Git remote configured
		let hasRemote = false;
		try {
			execSync("git remote get-url origin", {
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});
			hasRemote = true;
		} catch {
			/* no git remote */
		}
		results.push({
			passed: hasRemote,
			label: "Git remote configured",
			suggestion: 'No git remote "origin" found. Run "git remote add origin <url>".',
			category: "core",
		});

		// 6. Base branch exists locally
		const baseBranch = config?.base_branch || "main";
		let baseBranchExists = false;
		try {
			execSync(`git rev-parse --verify ${baseBranch}`, {
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});
			baseBranchExists = true;
		} catch {
			/* branch not found */
		}
		results.push({
			passed: baseBranchExists,
			label: `Base branch "${baseBranch}" exists`,
			suggestion: `Branch "${baseBranch}" not found locally. Run "git fetch origin ${baseBranch}" or update base_branch in .lisa/config.yaml.`,
			category: "core",
		});

		// 7. GitHub CLI authenticated (if platform=cli)
		if (!config?.platform || config.platform === "cli") {
			const ghAvailable = await isGhCliAvailable();
			results.push({
				passed: ghAvailable,
				label: "GitHub CLI authenticated",
				suggestion: 'Run "gh auth login" to authenticate the GitHub CLI.',
				category: "core",
			});
		}

		// Advanced checks (only if config loaded successfully)
		if (config) {
			results.push(...runAdvancedChecks(config));
		}

		// Print results grouped by category
		const coreResults = results.filter((r) => r.category === "core");
		const advancedResults = results.filter((r) => r.category === "advanced");

		console.error(pc.bold("  Core"));
		let hasFailure = false;
		for (const result of coreResults) {
			if (result.passed) {
				console.error(`  ${pc.green("\u2713")} ${result.label}`);
			} else {
				hasFailure = true;
				console.error(`  ${pc.red("\u2717")} ${result.label}`);
				if (result.suggestion) {
					console.error(`    ${pc.dim(result.suggestion)}`);
				}
			}
		}

		if (advancedResults.length > 0) {
			console.error(`\n${pc.bold("  Advanced")}`);
			for (const result of advancedResults) {
				if (result.passed) {
					console.error(`  ${pc.green("\u2713")} ${result.label}`);
				} else {
					hasFailure = true;
					console.error(`  ${pc.red("\u2717")} ${result.label}`);
					if (result.suggestion) {
						console.error(`    ${pc.dim(result.suggestion)}`);
					}
				}
			}
		}

		console.error("");
		if (hasFailure) {
			console.error("Some checks failed.\n");
			throw new CliError("Some checks failed.");
		} else {
			console.error("All checks passed!\n");
		}
	},
});
