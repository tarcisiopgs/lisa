import { execSync } from "node:child_process";
import { defineCommand } from "citty";
import pc from "picocolors";
import { configExists, loadConfig, validateConfig } from "../../config.js";
import { isGhCliAvailable } from "../../git/github.js";
import { createProvider } from "../../providers/index.js";
import { getMissingEnvVars } from "../detection.js";

interface CheckResult {
	passed: boolean;
	label: string;
	suggestion?: string;
}

export const doctor = defineCommand({
	meta: { name: "doctor", description: "Check your setup for common issues" },
	async run() {
		console.error("\nLisa Doctor\n");

		const results: CheckResult[] = [];

		// 1. Config file exists
		const hasConfig = configExists();
		results.push({
			passed: hasConfig,
			label: "Configuration file found",
			suggestion: 'Run "lisa init" to create a configuration file.',
		});

		// 2. Config validation passes
		let config = null;
		if (hasConfig) {
			try {
				config = loadConfig();
				validateConfig(config);
				results.push({ passed: true, label: "Configuration is valid" });
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				results.push({
					passed: false,
					label: "Configuration is valid",
					suggestion: msg,
				});
			}
		} else {
			results.push({
				passed: false,
				label: "Configuration is valid",
				suggestion: 'No configuration file found. Run "lisa init" first.',
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
				});
			} catch {
				results.push({
					passed: false,
					label: `Provider "${config.provider}" is installed`,
					suggestion: "Install it or change provider in .lisa/config.yaml",
				});
			}
		} else {
			results.push({
				passed: false,
				label: "Provider is configured",
				suggestion: 'Set a provider in .lisa/config.yaml or run "lisa init".',
			});
		}

		// 4. Required env vars for the configured source
		if (config?.source) {
			const missing = await getMissingEnvVars(config.source);
			if (missing.length === 0) {
				results.push({
					passed: true,
					label: `Source "${config.source}" environment variables are set`,
				});
			} else {
				results.push({
					passed: false,
					label: `Source "${config.source}" environment variables are set`,
					suggestion: `Missing: ${missing.join(", ")}. Add them to your shell profile.`,
				});
			}
		} else {
			results.push({
				passed: false,
				label: "Source is configured",
				suggestion: 'Set a source in .lisa/config.yaml or run "lisa init".',
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
		} catch {}
		results.push({
			passed: hasRemote,
			label: "Git remote configured",
			suggestion: 'No git remote "origin" found. Run "git remote add origin <url>".',
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
		} catch {}
		results.push({
			passed: baseBranchExists,
			label: `Base branch "${baseBranch}" exists`,
			suggestion: `Branch "${baseBranch}" not found locally. Run "git fetch origin ${baseBranch}" or update base_branch in .lisa/config.yaml.`,
		});

		// 7. GitHub CLI authenticated (if platform=cli)
		if (!config?.platform || config.platform === "cli") {
			const ghAvailable = await isGhCliAvailable();
			results.push({
				passed: ghAvailable,
				label: "GitHub CLI authenticated",
				suggestion: 'Run "gh auth login" to authenticate the GitHub CLI.',
			});
		}

		// Print results
		let hasFailure = false;
		for (const result of results) {
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

		console.error("");
		if (hasFailure) {
			console.error("Some checks failed.\n");
			process.exit(1);
		} else {
			console.error("All checks passed!\n");
		}
	},
});
