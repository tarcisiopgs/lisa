import { spawn } from "node:child_process";
import * as logger from "../output/logger.js";
import type {
	Issue,
	ProofOfWorkConfig,
	ValidationCommand,
	ValidationResult,
} from "../types/index.js";

const DEFAULT_TIMEOUT = 120_000;

/**
 * Runs a single validation command and returns the result.
 */
function runValidationCommand(
	cmd: ValidationCommand,
	cwd: string,
	timeoutMs: number,
): Promise<ValidationResult> {
	const start = Date.now();

	return new Promise((resolve) => {
		const proc = spawn("sh", ["-c", cmd.run], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env,
		});

		let output = "";
		let killed = false;

		const timer = setTimeout(() => {
			killed = true;
			proc.kill("SIGTERM");
			setTimeout(() => {
				try {
					proc.kill("SIGKILL");
				} catch {}
			}, 1_000);
		}, timeoutMs);

		proc.stdout?.on("data", (data: Buffer) => {
			output += data.toString();
		});
		proc.stderr?.on("data", (data: Buffer) => {
			output += data.toString();
		});

		proc.on("close", (code) => {
			clearTimeout(timer);
			const duration = Date.now() - start;
			if (killed) {
				resolve({
					name: cmd.name,
					success: false,
					output: `${output}\n[lisa-validation] Command timed out after ${timeoutMs}ms`,
					duration,
				});
			} else {
				resolve({ name: cmd.name, success: code === 0, output, duration });
			}
		});

		proc.on("error", (err) => {
			clearTimeout(timer);
			resolve({
				name: cmd.name,
				success: false,
				output: `Spawn error: ${err.message}`,
				duration: Date.now() - start,
			});
		});
	});
}

/**
 * Runs all validation commands sequentially and returns their results.
 */
export async function runValidationCommands(
	commands: ValidationCommand[],
	cwd: string,
	timeoutMs?: number,
): Promise<ValidationResult[]> {
	const timeout = timeoutMs ?? DEFAULT_TIMEOUT;
	const results: ValidationResult[] = [];

	for (const cmd of commands) {
		logger.log(`Validating: ${cmd.name} — ${cmd.run}`);
		const result = await runValidationCommand(cmd, cwd, timeout);
		results.push(result);

		if (result.success) {
			logger.ok(`${cmd.name}: passed (${Math.round(result.duration / 1000)}s)`);
		} else {
			logger.error(`${cmd.name}: failed (${Math.round(result.duration / 1000)}s)`);
		}
	}

	return results;
}

/**
 * Formats validation results as a Markdown section for the PR body.
 */
export function formatProofOfWork(results: ValidationResult[]): string {
	const lines: string[] = ["", "---", "## Proof of Work", ""];
	lines.push("| Check | Status | Duration |");
	lines.push("|-------|--------|----------|");

	for (const r of results) {
		const status = r.success ? "Pass" : "Fail";
		const duration = `${Math.round(r.duration / 1000)}s`;
		lines.push(`| ${r.name} | ${status} | ${duration} |`);
	}

	// Add details for failed checks
	const failures = results.filter((r) => !r.success);
	if (failures.length > 0) {
		lines.push("");
		for (const f of failures) {
			const trimmed = f.output.trim().slice(-2000);
			lines.push(`<details><summary>${f.name} output</summary>`);
			lines.push("");
			lines.push("```");
			lines.push(trimmed);
			lines.push("```");
			lines.push("");
			lines.push("</details>");
		}
	}

	return lines.join("\n");
}

/**
 * Builds a prompt for the agent to fix validation failures.
 */
export function buildValidationRecoveryPrompt(issue: Issue, failures: ValidationResult[]): string {
	const failureSections = failures
		.map((f) => {
			const trimmed = f.output.trim().slice(-3000);
			return `### ${f.name}\nCommand: \`${f.name}\`\nOutput:\n\`\`\`\n${trimmed}\n\`\`\``;
		})
		.join("\n\n");

	return `You are continuing work on issue ${issue.id}: "${issue.title}".

Your implementation has code changes but the following validation checks failed. Fix the issues, commit your changes, and push.

${failureSections}

IMPORTANT:
- Do NOT create a new branch — you are already on the correct branch.
- Fix ONLY the validation failures above.
- Commit and push your fixes.
- Do NOT create a PR — that will be handled separately.`;
}

/**
 * Returns true if proof_of_work is enabled and has commands configured.
 */
export function isProofOfWorkEnabled(config?: ProofOfWorkConfig): boolean {
	return !!(config?.enabled && config.commands.length > 0);
}
