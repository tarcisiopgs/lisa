import * as logger from "../output/logger.js";
import type { Source } from "../types/index.js";

export type ProgressStage =
	| "started"
	| "analyzing"
	| "implementing"
	| "validating"
	| "pr_created"
	| "ci_monitoring"
	| "failed";

interface StageInfo {
	emoji: string;
	message: string;
}

function formatStage(stage: ProgressStage, detail?: string): StageInfo {
	switch (stage) {
		case "started":
			return { emoji: "🤖", message: "Lisa started working on this issue" };
		case "analyzing":
			return { emoji: "🔍", message: "Analyzing codebase..." };
		case "implementing":
			return { emoji: "⌨️", message: `Implementing${detail ? ` with ${detail}` : ""}...` };
		case "validating":
			return { emoji: "✅", message: detail ?? "Running validation..." };
		case "pr_created":
			return { emoji: "🚀", message: `PR created: ${detail ?? ""}` };
		case "ci_monitoring":
			return { emoji: "🔄", message: "Monitoring CI..." };
		case "failed":
			return { emoji: "❌", message: `Failed: ${detail ?? "unknown error"}` };
	}
}

export class ProgressReporter {
	private commentId: string | null = null;
	private stages: string[] = [];
	private lastUpdate = 0;
	private readonly minInterval = 10_000; // 10s debounce

	constructor(
		private readonly source: Source,
		private readonly issueId: string,
		private readonly enabled: boolean,
	) {}

	async start(): Promise<void> {
		if (!this.enabled || !this.source.createComment) return;
		try {
			const { emoji, message } = formatStage("started");
			const body = `${emoji} ${message}`;
			this.stages.push(body);
			this.commentId = await this.source.createComment(this.issueId, body);
			this.lastUpdate = Date.now();
		} catch (err) {
			logger.warn(`Progress comment failed: ${err}`);
		}
	}

	async update(stage: ProgressStage, detail?: string): Promise<void> {
		if (!this.enabled) return;
		const { emoji, message } = formatStage(stage, detail);
		const line = `${emoji} ${message}`;
		this.stages.push(line);

		// Debounce updates
		const now = Date.now();
		if (now - this.lastUpdate < this.minInterval && stage !== "pr_created" && stage !== "failed") {
			return;
		}

		await this.flush();
	}

	async finish(prUrls: string[]): Promise<void> {
		if (!this.enabled) return;
		const { emoji, message } = formatStage("pr_created", prUrls[0]);
		this.stages.push(`${emoji} ${message}`);
		if (prUrls.length > 1) {
			for (const url of prUrls.slice(1)) {
				this.stages.push(`🚀 Additional PR: ${url}`);
			}
		}
		await this.flush();
	}

	async fail(error: string): Promise<void> {
		if (!this.enabled) return;
		await this.update("failed", error);
		await this.flush();
	}

	private async flush(): Promise<void> {
		const body = this.stages.join("\n");

		try {
			if (this.commentId && this.source.updateComment) {
				await this.source.updateComment(this.issueId, this.commentId, body);
			} else if (!this.commentId && this.source.createComment) {
				this.commentId = await this.source.createComment(this.issueId, body);
			}
			this.lastUpdate = Date.now();
		} catch (err) {
			logger.warn(`Progress comment update failed: ${err}`);
		}
	}
}
