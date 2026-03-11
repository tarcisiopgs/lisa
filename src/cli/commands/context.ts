import { join, resolve } from "node:path";
import { defineCommand } from "citty";
import { loadConfig } from "../../config.js";
import {
	buildContextGenerationPrompt,
	buildGlobalContextGenerationPrompt,
} from "../../loop/context-generation.js";
import { resolveModels } from "../../loop/models.js";
import * as logger from "../../output/logger.js";
import { runWithFallback } from "../../providers/index.js";
import { getContextPath, readContext } from "../../session/context-manager.js";

const refresh = defineCommand({
	meta: { description: "Regenerate .lisa/context.md for all repos (or a specific one)" },
	args: {
		repo: {
			type: "string",
			description: "Regenerate only the named repo (multi-repo only)",
		},
	},
	async run({ args }) {
		const config = loadConfig();
		const workspace = resolve(config.workspace);
		const models = resolveModels(config);
		const logFile = join(workspace, ".lisa", "context-refresh.log");
		const isMultiRepo = config.repos.length > 1;

		if (args.repo) {
			const repo = config.repos.find((r) => r.name === args.repo);
			if (!repo) {
				logger.error(`Repo "${args.repo}" not found in config.`);
				process.exit(1);
			}
			const absPath = resolve(workspace, repo.path);
			const prompt = buildContextGenerationPrompt(absPath, getContextPath(absPath));
			logger.log(`Refreshing context for ${repo.name}...`);
			await runWithFallback(models, prompt, {
				logFile,
				cwd: absPath,
				guardrailsDir: workspace,
				issueId: "__context_refresh__",
			});
			logger.ok(`Context refreshed for ${repo.name}.`);
			return;
		}

		if (isMultiRepo) {
			const repoList = config.repos.map((r) => ({
				name: r.name,
				path: resolve(workspace, r.path),
			}));
			logger.log("Refreshing global context...");
			await runWithFallback(
				models,
				buildGlobalContextGenerationPrompt(repoList, getContextPath(workspace)),
				{
					logFile,
					cwd: workspace,
					guardrailsDir: workspace,
					issueId: "__context_refresh_global__",
				},
			);
			for (const repo of config.repos) {
				const absPath = resolve(workspace, repo.path);
				logger.log(`Refreshing context for ${repo.name}...`);
				await runWithFallback(
					models,
					buildContextGenerationPrompt(absPath, getContextPath(absPath)),
					{
						logFile,
						cwd: absPath,
						guardrailsDir: workspace,
						issueId: `__context_refresh_${repo.name}__`,
					},
				);
			}
		} else {
			logger.log("Refreshing context...");
			await runWithFallback(
				models,
				buildContextGenerationPrompt(workspace, getContextPath(workspace)),
				{
					logFile,
					cwd: workspace,
					guardrailsDir: workspace,
					issueId: "__context_refresh__",
				},
			);
		}

		logger.ok("Context refresh complete.");
	},
});

export const context = defineCommand({
	meta: { description: "Manage project context for agent prompts" },
	subCommands: { refresh },
	async run() {
		const config = loadConfig();
		const workspace = resolve(config.workspace);
		const isMultiRepo = config.repos.length > 1;

		if (isMultiRepo) {
			const globalCtx = readContext(workspace);
			logger.log(`=== Global context (${workspace}/.lisa/context.md) ===`);
			logger.log(globalCtx ?? "(not generated yet — run `lisa context refresh`)");
			for (const repo of config.repos) {
				const absPath = resolve(workspace, repo.path);
				const repoCtx = readContext(absPath);
				logger.log(`\n=== ${repo.name} context (${absPath}/.lisa/context.md) ===`);
				logger.log(repoCtx ?? "(not generated yet — run `lisa context refresh`)");
			}
		} else {
			const ctx = readContext(workspace);
			logger.log(`=== Project context (${workspace}/.lisa/context.md) ===`);
			logger.log(ctx ?? "(not generated yet — run `lisa context refresh`)");
		}
	},
});
