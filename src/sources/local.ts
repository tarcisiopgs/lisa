import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Issue, Source, SourceConfig } from "../types.js";

const ISSUES_DIR = ".matuto/issues";
const DONE_DIR = ".matuto/issues/done";

export class LocalSource implements Source {
	name = "local" as const;

	buildFetchPrompt(_config: SourceConfig): string {
		throw new Error("Local source does not use provider-based fetching.");
	}

	buildUpdatePrompt(_issueId: string, _status: string): string {
		throw new Error("Local source does not use provider-based status updates.");
	}

	buildRemoveLabelPrompt(_issueId: string, _label: string): string {
		throw new Error("Local source does not use provider-based label removal.");
	}

	parseIssueId(_output: string): string | null {
		throw new Error("Local source does not use provider-based issue parsing.");
	}

	async fetchNextLocal(cwd: string): Promise<Issue | null> {
		const issuesDir = resolve(cwd, ISSUES_DIR);

		if (!existsSync(issuesDir)) return null;

		const files = readdirSync(issuesDir)
			.filter((f) => f.endsWith(".md"))
			.sort();

		if (files.length === 0) return null;

		const file = files[0]!;
		const filePath = join(issuesDir, file);
		const raw = readFileSync(filePath, "utf-8");

		const { frontmatter, body } = parseFrontmatter(raw);
		const title = kebabToTitle(basename(file, ".md"));

		return {
			id: basename(file, ".md"),
			title,
			description: body.trim(),
			url: filePath,
			repo: frontmatter.repo,
		};
	}

	async markDone(issueId: string, cwd: string): Promise<void> {
		const issuesDir = resolve(cwd, ISSUES_DIR);
		const doneDir = resolve(cwd, DONE_DIR);
		const src = join(issuesDir, `${issueId}.md`);

		if (!existsSync(src)) return;

		if (!existsSync(doneDir)) {
			mkdirSync(doneDir, { recursive: true });
		}

		renameSync(src, join(doneDir, `${issueId}.md`));
	}
}

function parseFrontmatter(raw: string): { frontmatter: Record<string, string>; body: string } {
	const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);

	if (!match) return { frontmatter: {}, body: raw };

	const frontmatter: Record<string, string> = {};
	for (const line of match[1]!.split("\n")) {
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		const key = line.slice(0, idx).trim();
		const value = line.slice(idx + 1).trim();
		if (key) frontmatter[key] = value;
	}

	return { frontmatter, body: match[2] ?? "" };
}

function kebabToTitle(slug: string): string {
	return slug
		.split("-")
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ");
}
