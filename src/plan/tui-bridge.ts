import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveModels } from "../loop/models.js";
import * as logger from "../output/logger.js";
import { runWithFallback } from "../providers/index.js";
import { createSource } from "../sources/index.js";
import type { LisaConfig, PlannedIssue, PlanResult } from "../types/index.js";
import { kanbanEmitter } from "../ui/state.js";
import { createPlanIssues } from "./create.js";
import { PlanParseError, parsePlanResponse } from "./parser.js";
import { savePlan } from "./persistence.js";
import { buildPlanningPrompt } from "./prompt.js";

const MAX_PARSE_RETRIES = 2;

/**
 * Register plan event listeners on the kanban emitter.
 * Called once when the TUI starts. Returns a cleanup function.
 */
export function registerPlanBridge(config: LisaConfig): () => void {
	const chatHistory: { role: "user" | "ai"; content: string }[] = [];
	let goal = "";

	const onUserMessage = (message: string) => {
		chatHistory.push({ role: "user", content: message });
		if (!goal) goal = message;

		// Run AI asynchronously — don't block the TUI
		handleUserMessage(config, goal, chatHistory).catch((err) => {
			kanbanEmitter.emit(
				"plan:ai-message",
				`Error: ${err instanceof Error ? err.message : String(err)}`,
			);
		});
	};

	const onApproved = (issues: PlannedIssue[], approvedGoal: string) => {
		handleApproval(config, issues, approvedGoal).catch((err) => {
			logger.error(`Plan approval failed: ${err instanceof Error ? err.message : String(err)}`);
		});
	};

	const onEditIssue = (index: number) => {
		// Edit runs synchronously (blocks TUI while $EDITOR is open)
		// The TUI will resume when the editor closes
		kanbanEmitter.emit("plan:edit-result", index, null);
	};

	kanbanEmitter.on("plan:user-message", onUserMessage);
	kanbanEmitter.on("plan:approved", onApproved);
	kanbanEmitter.on("plan:edit-issue", onEditIssue);

	return () => {
		kanbanEmitter.off("plan:user-message", onUserMessage);
		kanbanEmitter.off("plan:approved", onApproved);
		kanbanEmitter.off("plan:edit-issue", onEditIssue);
	};
}

async function handleUserMessage(
	config: LisaConfig,
	goal: string,
	chatHistory: { role: string; content: string }[],
): Promise<void> {
	kanbanEmitter.emit("plan:thinking");

	const prompt = buildChatPrompt(goal, config, chatHistory);
	const models = resolveModels(config);
	const logDir = mkdtempSync(join(tmpdir(), "lisa-plan-"));
	const logFile = join(logDir, "plan.log");

	const result = await runWithFallback(models, prompt, {
		logFile,
		cwd: resolve(config.workspace),
		sessionTimeout: 120,
	});

	if (!result.success) {
		kanbanEmitter.emit("plan:ai-message", "Failed to get AI response. Try again.");
		return;
	}

	// Try to parse as issue JSON — if it works, the AI is done brainstorming
	try {
		const issues = parsePlanResponse(result.output);
		chatHistory.push({ role: "ai", content: `Decomposed into ${issues.length} issues.` });
		kanbanEmitter.emit("plan:issues-ready", issues);
		return;
	} catch {
		// Not JSON — it's a chat response (clarifying question or refinement)
	}

	// Extract just the AI's text response (strip any system noise)
	const response = extractChatResponse(result.output);
	chatHistory.push({ role: "ai", content: response });
	kanbanEmitter.emit("plan:ai-message", response);
}

async function handleApproval(
	config: LisaConfig,
	issues: PlannedIssue[],
	goal: string,
): Promise<void> {
	const source = createSource(config.source);
	if (!source.createIssue) {
		logger.error(`Source "${config.source}" does not support issue creation.`);
		return;
	}

	const plan: PlanResult = {
		goal,
		issues,
		createdAt: new Date().toISOString(),
		status: "approved",
	};

	logger.log("Creating issues in source...");
	const createdIds = await createPlanIssues(source, config.source_config, plan);

	plan.status = "created";
	plan.createdIssueIds = createdIds;
	savePlan(resolve(config.workspace), plan);

	logger.ok(`${createdIds.length} issue${createdIds.length !== 1 ? "s" : ""} created via plan.`);
}

/**
 * Build a chat-aware prompt. If the AI has enough context, it should
 * decompose into issues. Otherwise, it can ask a clarifying question.
 */
function buildChatPrompt(
	goal: string,
	config: LisaConfig,
	chatHistory: { role: string; content: string }[],
): string {
	const basePrompt = buildPlanningPrompt(goal, config);

	if (chatHistory.length <= 1) {
		// First message — add instruction to either ask or decompose
		return `${basePrompt}

## Chat Mode

The user has just described their goal. You have two options:

1. **If the goal is clear and specific enough** to decompose into issues, output the JSON immediately.
2. **If you need clarification** (which endpoints? what technology? what scope?), respond with a SHORT question (1-2 sentences). Do NOT output JSON — just plain text.

Prefer decomposing directly when possible. Only ask if the goal is genuinely ambiguous.`;
	}

	// Subsequent messages — include chat history
	const historyBlock = chatHistory
		.map((m) => `${m.role === "user" ? "User" : "AI"}: ${m.content}`)
		.join("\n\n");

	return `${basePrompt}

## Conversation History

${historyBlock}

## Instructions

Based on the conversation above, either:
1. **Decompose into issues** — output the JSON structure defined above.
2. **Ask one more question** — respond with SHORT plain text (1-2 sentences). No JSON.

If you have enough context, decompose now. Do not ask more than 3 questions total.`;
}

/** Extract the meaningful text from provider output, stripping noise. */
function extractChatResponse(output: string): string {
	// Remove ANSI escape codes
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI stripping
	const cleaned = output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trim();

	// If it's very short, return as-is
	if (cleaned.length < 500) return cleaned;

	// Try to find the last substantial paragraph (skip tool calls, etc.)
	const lines = cleaned.split("\n").filter((l) => l.trim().length > 0);
	// Take the last 10 non-empty lines as the response
	return lines.slice(-10).join("\n");
}
