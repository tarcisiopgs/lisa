import { resolve } from "node:path";
import { formatError } from "../errors.js";
import * as logger from "../output/logger.js";
import { runWithFallback } from "../providers/index.js";
import { contextExists, getContextPath } from "../session/context-manager.js";
import type { LisaConfig, ModelSpec } from "../types/index.js";

export function buildContextGenerationPrompt(repoPath: string, outputPath: string): string {
	return `You are a project analyst. Your job is to document this repository so that future autonomous agents can work in it correctly.

Repository path: \`${repoPath}\`

Read the project files and write \`${outputPath}\` with a concise markdown document covering:

1. **Stack & Tools**: tools detected in this project and the EXACT commands to use (e.g., if package.json has a \`generate\` script, say "run \`pnpm run generate\` — not \`npx orval\` directly")
2. **File conventions**: where generated files live, migration naming patterns, any naming conventions observed from existing files
3. **Constraints**: anything an agent should NOT do (e.g., "do not run migrations manually — always use the \`db:push\` script")

Rules:
- Be concise — max 300 words. This is injected into every agent prompt.
- Write only what is non-obvious. Do NOT explain what tools are — only how they are used in THIS project.
- If nothing non-obvious exists (e.g., a plain Node.js project with no special tooling), write a single line: "No special tooling conventions."
- Do NOT create branches, commit, or make any changes other than writing \`${outputPath}\`.`;
}

export function buildGlobalContextGenerationPrompt(
	repos: Array<{ name: string; path: string }>,
	outputPath: string,
): string {
	const repoList = repos.map((r) => `- **${r.name}**: \`${r.path}\``).join("\n");

	return `You are a project analyst for a multi-repo workspace. Your job is to document the relationships between repositories so that future autonomous agents can coordinate work across them correctly.

Repositories:
${repoList}

Read the relevant config files in each repository and write \`${outputPath}\` with a concise markdown document covering:

1. **Repo relationships**: how repos depend on each other (e.g., "frontend reads backend OpenAPI spec from http://localhost:3000/openapi.json")
2. **Execution ordering rules**: which repo must be implemented first when multiple repos are affected (e.g., "backend changes must precede frontend API client regeneration")
3. **Shared conventions**: anything that applies across all repos

Rules:
- Be concise — max 200 words.
- Document only the relationship and ordering information. Repo-specific tooling goes in each repo's own context.md.
- If repos are independent (no API sharing, no codegen), write: "Repos are independent — no cross-repo execution ordering constraints."
- Do NOT create branches, commit, or make any changes other than writing \`${outputPath}\`.`;
}

export async function generateRepoContext(
	repoPath: string,
	models: ModelSpec[],
	logFile: string,
	guardrailsDir: string,
): Promise<void> {
	if (contextExists(repoPath)) return;

	logger.log(`Generating context for ${repoPath}...`);
	const outputPath = getContextPath(repoPath);
	const prompt = buildContextGenerationPrompt(repoPath, outputPath);

	try {
		await runWithFallback(models, prompt, {
			logFile,
			cwd: repoPath,
			guardrailsDir,
			issueId: "__context_gen__",
		});
		logger.ok(`Context generated: ${outputPath}`);
	} catch (err) {
		logger.warn(
			`Context generation failed for ${repoPath}: ${formatError(err)}. Proceeding without context.md.`,
		);
	}
}

export async function generateGlobalContext(
	workspacePath: string,
	repos: Array<{ name: string; path: string }>,
	models: ModelSpec[],
	logFile: string,
): Promise<void> {
	if (contextExists(workspacePath)) return;

	logger.log("Generating global workspace context...");
	const outputPath = getContextPath(workspacePath);
	const prompt = buildGlobalContextGenerationPrompt(repos, outputPath);

	try {
		await runWithFallback(models, prompt, {
			logFile,
			cwd: workspacePath,
			guardrailsDir: workspacePath,
			issueId: "__context_gen_global__",
		});
		logger.ok(`Global context generated: ${outputPath}`);
	} catch (err) {
		logger.warn(
			`Global context generation failed: ${formatError(err)}. Proceeding without global context.md.`,
		);
	}
}

export async function ensureWorkspaceContext(
	config: LisaConfig,
	models: ModelSpec[],
	workspace: string,
	logFile: string,
): Promise<void> {
	const isMultiRepo = config.repos.length > 1;

	if (isMultiRepo) {
		const repoList = config.repos.map((r) => ({
			name: r.name,
			path: resolve(workspace, r.path),
		}));
		await generateGlobalContext(workspace, repoList, models, logFile);

		for (const repo of config.repos) {
			const absPath = resolve(workspace, repo.path);
			await generateRepoContext(absPath, models, logFile, workspace);
		}
	} else {
		await generateRepoContext(workspace, models, logFile, workspace);
	}
}
