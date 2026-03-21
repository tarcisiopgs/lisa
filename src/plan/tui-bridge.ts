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
import { savePlan } from "./persistence.js";
import { buildPlanningPrompt } from "./prompt.js";
import { parseStructuredOutput } from "./structured-output.js";
import { issueToMarkdown, markdownToIssue } from "./wizard.js";

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

	const onEditIssue = (index: number, issue?: PlannedIssue) => {
		if (!issue) return;

		const tmpDir = mkdtempSync(join(tmpdir(), "lisa-edit-"));
		const tmpFile = join(tmpDir, "issue.md");
		writeFileSync(tmpFile, issueToMarkdown(issue));

		const editor = process.env.EDITOR || process.env.VISUAL || "vi";
		try {
			execSync(`${editor} "${tmpFile}"`, { stdio: "inherit" });
		} catch {
			return;
		}

		const content = readFileSync(tmpFile, "utf-8");
		const updated = markdownToIssue(content, issue);
		kanbanEmitter.emit("plan:edit-result", index, updated);
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

	const parsed = parseStructuredOutput(result.output);

	switch (parsed.type) {
		case "issues": {
			chatHistory.push({ role: "ai", content: `Decomposed into ${parsed.issues.length} issues.` });
			kanbanEmitter.emit("plan:issues-ready", parsed.issues);
			break;
		}
		case "summary": {
			chatHistory.push({ role: "ai", content: parsed.text });
			kanbanEmitter.emit("plan:ai-message", parsed.text);
			kanbanEmitter.emit("plan:summary-ready");
			break;
		}
		case "question": {
			chatHistory.push({ role: "ai", content: parsed.text });
			kanbanEmitter.emit("plan:ai-message", parsed.text);
			break;
		}
	}
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

	// Re-fetch issues from source to populate the kanban backlog
	try {
		const allIssues = await source.listIssues(config.source_config);
		for (const issue of allIssues) {
			kanbanEmitter.emit("issue:queued", issue);
		}
	} catch (err) {
		logger.warn(`Could not refresh kanban: ${err instanceof Error ? err.message : String(err)}`);
	}
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

	const responseFormat = `## Response Format

ALWAYS respond with a single JSON object (no markdown fences, no extra text). Use one of these formats:

- To ask a clarifying question: {"type": "question", "text": "your question"}
- To present your understanding before decomposing: {"type": "summary", "text": "your structured summary"}
- To deliver the final plan: {"type": "issues", "issues": [<issues array as defined above>]}

Output ONLY the JSON object. No wrapping, no explanation before or after.`;

	if (chatHistory.length <= 1) {
		return `${basePrompt}

## Chat Mode

The user has just described their goal. You have two options:

1. **If the goal is clear and specific enough** to decompose into issues, respond with type "issues".
2. **If you need clarification** (which endpoints? what technology? what scope?), respond with type "question".

Prefer decomposing directly when possible. Only ask if the goal is genuinely ambiguous.

${responseFormat}`;
	}

	const historyBlock = chatHistory
		.map((m) => `${m.role === "user" ? "User" : "AI"}: ${m.content}`)
		.join("\n\n");

	return `${basePrompt}

## Conversation History

${historyBlock}

## Instructions

Based on the conversation above, either:
1. **Decompose into issues** — respond with type "issues".
2. **Present your understanding** — respond with type "summary" if you're confident you understand but haven't decomposed yet.
3. **Ask one more question** — respond with type "question".

If you have enough context, decompose now.

${responseFormat}`;
}
