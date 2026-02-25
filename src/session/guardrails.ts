import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getGuardrailsPath } from "../paths.js";

const LEGACY_GUARDRAILS_FILE = ".lisa/guardrails.md";
const MAX_ENTRIES = 20;
const CONTEXT_LINES = 20;

export interface GuardrailEntry {
	issueId: string;
	date: string;
	provider: string;
	errorType: string;
	context: string;
}

export function guardrailsPath(cwd: string): string {
	return getGuardrailsPath(cwd);
}

/**
 * Migrates legacy .lisa/guardrails.md to the cache directory if it exists.
 */
export function migrateGuardrails(cwd: string): void {
	const legacyPath = join(cwd, LEGACY_GUARDRAILS_FILE);
	if (!existsSync(legacyPath)) return;

	const cachePath = getGuardrailsPath(cwd);
	if (existsSync(cachePath)) return;

	const cacheDir = dirname(cachePath);
	if (!existsSync(cacheDir)) {
		mkdirSync(cacheDir, { recursive: true });
	}

	copyFileSync(legacyPath, cachePath);
}

export function readGuardrails(cwd: string): string {
	const path = getGuardrailsPath(cwd);
	if (!existsSync(path)) return "";
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return "";
	}
}

export function buildGuardrailsSection(cwd: string): string {
	const content = readGuardrails(cwd);
	if (!content.trim()) return "";
	return `\n## Guardrails — Avoid these known pitfalls\n\n${content}\n`;
}

export function extractContext(output: string): string {
	const lines = output.trim().split("\n");
	return lines.slice(-CONTEXT_LINES).join("\n");
}

export function extractErrorType(output: string): string {
	if (/429|rate.?limit|quota/i.test(output)) return "Rate limit / quota exceeded";
	if (/ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND/.test(output)) return "Network error";
	if (/timeout|timed?\s*out/i.test(output)) return "Timeout";
	const exitMatch = output.match(/exit code[:\s]+(\d+)/i);
	if (exitMatch) return `Exit code ${exitMatch[1]}`;
	if (/exit(?:ed)? with/i.test(output)) return "Non-zero exit code";
	return "Unknown error";
}

export function appendEntry(dir: string, entry: GuardrailEntry): void {
	const path = guardrailsPath(dir);
	const guardrailsDir = dirname(path);

	if (!existsSync(guardrailsDir)) {
		mkdirSync(guardrailsDir, { recursive: true });
	}

	const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
	const newEntryText = formatEntry(entry);

	let content: string;
	if (!existing.trim()) {
		content = `# Guardrails — Lições aprendidas\n\n${newEntryText}`;
	} else {
		const header = extractHeader(existing);
		const entries = splitEntries(existing);
		entries.push(newEntryText);
		const rotated = entries.length > MAX_ENTRIES ? entries.slice(-MAX_ENTRIES) : entries;
		content = `${header}\n\n${rotated.join("\n\n")}`;
	}

	writeFileSync(path, content, "utf-8");
}

function formatEntry(entry: GuardrailEntry): string {
	return [
		`## Issue ${entry.issueId} (${entry.date})`,
		`- Provider: ${entry.provider}`,
		`- Erro: ${entry.errorType}`,
		`- Contexto:`,
		"```",
		entry.context,
		"```",
	].join("\n");
}

function extractHeader(content: string): string {
	const firstEntry = content.search(/^## /m);
	if (firstEntry === -1) return content.trim();
	return content.slice(0, firstEntry).trim();
}

function splitEntries(content: string): string[] {
	const positions: number[] = [];
	const regex = /^## /gm;

	for (const match of content.matchAll(regex)) {
		positions.push(match.index);
	}

	return positions.map((start, i) => {
		const end = positions[i + 1] ?? content.length;
		return content.slice(start, end).trim();
	});
}
