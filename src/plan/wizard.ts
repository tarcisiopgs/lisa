import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as clack from "@clack/prompts";
import pc from "picocolors";
import * as logger from "../output/logger.js";
import type { PlannedIssue, PlanResult } from "../types/index.js";
import { generatePlan } from "./generate.js";
import type { RunPlanOptions } from "./index.js";
import { savePlan } from "./persistence.js";

/**
 * Interactive wizard for reviewing and editing a plan.
 * Returns true if the user approved the plan, false if cancelled.
 */
export async function runPlanWizard(
	plan: PlanResult,
	planPath: string,
	opts: RunPlanOptions,
): Promise<boolean> {
	const workspace = opts.config.workspace;

	while (true) {
		displayPlan(plan);

		const action = await clack.select({
			message: "What would you like to do?",
			options: [
				{ value: "approve", label: `${pc.green("Approve all")} — create issues in source` },
				{ value: "edit", label: `${pc.yellow("Edit")} — edit an issue in $EDITOR` },
				{ value: "delete", label: `${pc.red("Delete")} — remove an issue` },
				{ value: "reorder", label: `${pc.cyan("Reorder")} — change execution order` },
				{
					value: "regenerate",
					label: `${pc.magenta("Regenerate")} — regenerate plan with feedback`,
				},
				{ value: "cancel", label: `${pc.gray("Cancel")} — save and exit` },
			],
		});

		if (clack.isCancel(action) || action === "cancel") {
			plan.status = "draft";
			savePlan(workspace, plan);
			return false;
		}

		if (action === "approve") {
			plan.status = "approved";
			savePlan(workspace, plan);
			return true;
		}

		if (action === "edit") {
			await editIssue(plan, workspace);
			savePlan(workspace, plan);
		}

		if (action === "delete") {
			await deleteIssue(plan, workspace);
			savePlan(workspace, plan);
		}

		if (action === "reorder") {
			await reorderIssues(plan, workspace);
			savePlan(workspace, plan);
		}

		if (action === "regenerate") {
			const regenerated = await regeneratePlan(plan, opts);
			if (regenerated) {
				plan.issues = regenerated;
				savePlan(workspace, plan);
			}
		}
	}
}

function displayPlan(plan: PlanResult): void {
	clack.log.info(`${pc.bold("Goal:")} ${plan.goal}`);
	clack.log.info("");

	const sorted = [...plan.issues].sort((a, b) => a.order - b.order);
	for (const issue of sorted) {
		const deps =
			issue.dependsOn.length > 0
				? pc.gray(` → depends on: ${issue.dependsOn.map((d) => `#${d}`).join(", ")}`)
				: "";
		const repo = issue.repo ? pc.cyan(` [${issue.repo}]`) : "";
		const files =
			issue.relevantFiles.length > 0
				? pc.gray(
						`\n     Files: ${issue.relevantFiles.slice(0, 3).join(", ")}${issue.relevantFiles.length > 3 ? ` +${issue.relevantFiles.length - 3}` : ""}`,
					)
				: "";

		clack.log.info(
			`  ${pc.yellow(String(issue.order))}. ${pc.bold(issue.title)}${repo}${deps}${files}`,
		);
	}
	clack.log.info("");
}

async function editIssue(plan: PlanResult, workspace: string): Promise<void> {
	if (plan.issues.length === 0) {
		clack.log.warning("No issues to edit.");
		return;
	}

	const choice = await clack.select({
		message: "Which issue to edit?",
		options: plan.issues.map((issue) => ({
			value: issue.order,
			label: `${issue.order}. ${issue.title}`,
		})),
	});

	if (clack.isCancel(choice)) return;

	const issue = plan.issues.find((i) => i.order === choice);
	if (!issue) return;

	// Write issue to temp file as markdown
	const tmpDir = mkdtempSync(join(tmpdir(), "lisa-edit-"));
	const tmpFile = join(tmpDir, "issue.md");
	writeFileSync(tmpFile, issueToMarkdown(issue));

	// Open in $EDITOR
	const editor = process.env.EDITOR || process.env.VISUAL || "vi";
	try {
		execSync(`${editor} "${tmpFile}"`, { stdio: "inherit" });
	} catch {
		clack.log.error("Editor failed. Issue unchanged.");
		return;
	}

	// Read back and parse
	const content = readFileSync(tmpFile, "utf-8");
	const updated = markdownToIssue(content, issue);
	Object.assign(issue, updated);
	clack.log.success(`Updated: ${issue.title}`);
}

async function deleteIssue(plan: PlanResult, _workspace: string): Promise<void> {
	if (plan.issues.length === 0) {
		clack.log.warning("No issues to delete.");
		return;
	}

	const choice = await clack.select({
		message: "Which issue to delete?",
		options: plan.issues.map((issue) => ({
			value: issue.order,
			label: `${issue.order}. ${issue.title}`,
		})),
	});

	if (clack.isCancel(choice)) return;

	const idx = plan.issues.findIndex((i) => i.order === choice);
	if (idx === -1) return;

	const removed = plan.issues.splice(idx, 1)[0]!;

	// Update dependsOn references
	for (const issue of plan.issues) {
		issue.dependsOn = issue.dependsOn.filter((d) => d !== removed.order);
	}

	clack.log.success(`Deleted: ${removed.title}`);
}

async function reorderIssues(plan: PlanResult, _workspace: string): Promise<void> {
	if (plan.issues.length <= 1) {
		clack.log.warning("Need at least 2 issues to reorder.");
		return;
	}

	clack.log.info("Enter new order (comma-separated issue numbers):");
	clack.log.info(
		`Current: ${plan.issues
			.sort((a, b) => a.order - b.order)
			.map((i) => i.order)
			.join(", ")}`,
	);

	const answer = await clack.text({
		message: "New order (e.g., 3,1,2,4):",
		validate: (input = "") => {
			const nums = input.split(",").map((n) => Number(n.trim()));
			if (nums.some(Number.isNaN)) return "Enter comma-separated numbers";
			if (nums.length !== plan.issues.length) return `Expected ${plan.issues.length} numbers`;
			return undefined;
		},
	});

	if (clack.isCancel(answer)) return;

	const newOrder = (answer as string).split(",").map((n) => Number(n.trim()));
	const oldOrderMap = new Map<number, PlannedIssue>();
	for (const issue of plan.issues) {
		oldOrderMap.set(issue.order, issue);
	}

	// Reassign orders based on position in newOrder
	for (let i = 0; i < newOrder.length; i++) {
		const issue = oldOrderMap.get(newOrder[i]!);
		if (issue) {
			issue.order = i + 1;
		}
	}

	clack.log.success("Issues reordered.");
}

async function regeneratePlan(
	plan: PlanResult,
	opts: RunPlanOptions,
): Promise<PlannedIssue[] | null> {
	const feedback = await clack.text({
		message: "What would you like to change?",
		placeholder: 'e.g., "Group into max 3 issues" or "Add tests for each issue"',
		validate: (v) => (!v?.trim() ? "Please describe what to change" : undefined),
	});

	if (clack.isCancel(feedback)) return null;

	const spinner = clack.spinner();
	spinner.start("Regenerating plan...");

	try {
		const issues = await generatePlan(plan.goal, opts.config, {
			feedback: feedback as string,
			previousTitles: plan.issues.map((i) => i.title),
		});
		spinner.stop("Plan regenerated.");
		return issues;
	} catch (err) {
		spinner.stop("Regeneration failed.");
		logger.error(`Failed to regenerate: ${err instanceof Error ? err.message : String(err)}`);
		return null;
	}
}

export function issueToMarkdown(issue: PlannedIssue): string {
	let md = `# ${issue.title}\n\n`;
	md += `${issue.description}\n`;

	if (issue.relevantFiles.length > 0) {
		md += `\n## Relevant Files\n\n`;
		for (const f of issue.relevantFiles) {
			md += `- ${f}\n`;
		}
	}

	return md;
}

export function markdownToIssue(content: string, original: PlannedIssue): Partial<PlannedIssue> {
	const lines = content.split("\n");
	const titleLine = lines.find((l) => l.startsWith("# "));
	const title = titleLine ? titleLine.replace(/^#\s+/, "").trim() : original.title;

	// Everything between the title and "## Relevant Files" is the description
	const titleIdx = lines.indexOf(titleLine ?? "");
	const filesIdx = lines.findIndex((l) => l.startsWith("## Relevant Files"));
	const descLines = filesIdx > 0 ? lines.slice(titleIdx + 1, filesIdx) : lines.slice(titleIdx + 1);
	const description = descLines.join("\n").trim();

	// Extract acceptance criteria from - [ ] items
	const acceptanceCriteria = descLines
		.filter((l) => l.trim().startsWith("- [ ]") || l.trim().startsWith("- [x]"))
		.map((l) => l.trim().replace(/^- \[[ x]\]\s*/, ""));

	// Extract files
	const relevantFiles: string[] = [];
	if (filesIdx > 0) {
		for (let i = filesIdx + 1; i < lines.length; i++) {
			const line = lines[i]!.trim();
			if (line.startsWith("- ")) {
				relevantFiles.push(line.replace(/^- /, ""));
			} else if (line.startsWith("#")) {
				break;
			}
		}
	}

	return {
		title,
		description: description || original.description,
		acceptanceCriteria:
			acceptanceCriteria.length > 0 ? acceptanceCriteria : original.acceptanceCriteria,
		relevantFiles: relevantFiles.length > 0 ? relevantFiles : original.relevantFiles,
	};
}
