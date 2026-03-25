import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as clack from "@clack/prompts";
import { resolveModels } from "../loop/models.js";
import * as logger from "../output/logger.js";
import { buildContextMdBlock } from "../prompt.js";
import { runWithFallback } from "../providers/index.js";
import { readContext } from "../session/context-manager.js";
import type { ChatMessage, LisaConfig } from "../types/index.js";
import { parseStructuredOutput } from "./structured-output.js";

export interface BrainstormResult {
	refinedGoal: string;
	history: ChatMessage[];
	summary: string;
}

/**
 * Run an interactive brainstorming phase in the CLI.
 * The AI asks clarifying questions until it has enough context,
 * then presents a summary of understanding.
 */
export async function runBrainstormingPhase(
	goal: string,
	config: LisaConfig,
): Promise<BrainstormResult> {
	const history: ChatMessage[] = [];
	const models = resolveModels(config);
	const logDir = mkdtempSync(join(tmpdir(), "lisa-brainstorm-"));
	const logFile = join(logDir, "brainstorm.log");
	const cwd = resolve(config.workspace);

	logger.log("Starting brainstorming phase...");

	while (true) {
		const prompt = buildBrainstormingPrompt(goal, config, history);

		const spinner = clack.spinner();
		spinner.start("Thinking...");

		const result = await runWithFallback(models, prompt, {
			logFile,
			cwd,
			sessionTimeout: 120,
		});

		spinner.stop();

		if (!result.success) {
			logger.error("AI failed to respond. Skipping brainstorming.");
			return { refinedGoal: goal, history, summary: goal };
		}

		const parsed = parseStructuredOutput(result.output);

		if (parsed.type === "summary") {
			history.push({ role: "ai", content: parsed.text });
			clack.log.info(parsed.text);
			return { refinedGoal: parsed.text, history, summary: parsed.text };
		}

		// If AI returned issues directly (skipped brainstorming), treat as summary
		if (parsed.type === "issues") {
			const summary = `Decomposed into ${parsed.issues.length} issues directly.`;
			history.push({ role: "ai", content: summary });
			return { refinedGoal: goal, history, summary: goal };
		}

		// Show question and get user answer
		history.push({ role: "ai", content: parsed.text });
		const answer = await clack.text({
			message: parsed.text,
			placeholder: 'Type your answer, or "/go" to skip to generation',
		});

		if (clack.isCancel(answer)) {
			return { refinedGoal: goal, history, summary: goal };
		}

		const answerText = (answer as string).trim();
		if (answerText === "/go") {
			return { refinedGoal: goal, history, summary: goal };
		}

		history.push({ role: "user", content: answerText });
	}
}

/**
 * Build a brainstorming prompt focused on understanding the goal.
 */
export function buildBrainstormingPrompt(
	goal: string,
	config: LisaConfig,
	history: ChatMessage[],
): string {
	const workspace = resolve(config.workspace);
	const contextMd = readContext(workspace);
	const contextBlock = buildContextMdBlock(contextMd);

	const historyBlock =
		history.length > 0
			? `\n## Conversation History\n\n${history.map((m) => `${m.role === "user" ? "User" : "AI"}: ${m.content}`).join("\n\n")}\n`
			: "";

	return `You are a requirements analyst. Your job is to deeply understand the user's goal before any implementation planning begins.

Always respond in the same language the user wrote their goal in.

## Goal

${goal}
${contextBlock}${historyBlock}
## Instructions

Ask focused questions about: scope, constraints, existing patterns, edge cases, and success criteria.
Ask at most 2-3 focused questions total. When you fully understand the goal, present a structured summary.

ALWAYS respond with a single JSON object (no markdown fences, no extra text):

- To ask a question: {"type": "question", "text": "your question"}
- To present your understanding: {"type": "summary", "text": "structured summary of what you understood"}

Output ONLY the JSON object.`;
}
