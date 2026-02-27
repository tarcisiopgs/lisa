import { describe, expect, it } from "vitest";
import {
	CONFIG_TEMPLATES,
	getTemplateById,
	getTemplates,
	templateToPartialConfig,
} from "./templates.js";

describe("getTemplates", () => {
	it("returns all templates", () => {
		const templates = getTemplates();
		expect(templates.length).toBeGreaterThan(0);
		expect(templates).toBe(CONFIG_TEMPLATES);
	});

	it("all templates have required fields", () => {
		const templates = getTemplates();
		for (const t of templates) {
			expect(t.id).toBeTruthy();
			expect(t.label).toBeTruthy();
			expect(t.hint).toBeTruthy();
			expect(t.provider).toBeTruthy();
			expect(t.source).toBeTruthy();
			expect(t.workflow).toMatch(/^(worktree|branch)$/);
			expect(t.sourceDefaults.label).toBeTruthy();
			expect(t.sourceDefaults.pick_from).toBeTruthy();
			expect(t.sourceDefaults.in_progress).toBeTruthy();
			expect(t.sourceDefaults.done).toBeTruthy();
		}
	});

	it("all template IDs are unique", () => {
		const templates = getTemplates();
		const ids = templates.map((t) => t.id);
		const unique = new Set(ids);
		expect(unique.size).toBe(ids.length);
	});
});

describe("getTemplateById", () => {
	it("returns the correct template for a known id", () => {
		const template = getTemplateById("github-claude");
		expect(template).toBeDefined();
		expect(template?.provider).toBe("claude");
		expect(template?.source).toBe("github-issues");
	});

	it("returns undefined for an unknown id", () => {
		expect(getTemplateById("unknown-template")).toBeUndefined();
	});

	it("returns linear-claude template with correct defaults", () => {
		const template = getTemplateById("linear-claude");
		expect(template?.sourceDefaults.pick_from).toBe("Todo");
		expect(template?.sourceDefaults.in_progress).toBe("In Progress");
		expect(template?.sourceDefaults.done).toBe("In Review");
	});
});

describe("templateToPartialConfig", () => {
	it("converts github-claude template to a LisaConfig", () => {
		const template = getTemplateById("github-claude")!;
		const config = templateToPartialConfig(template);
		expect(config.provider).toBe("claude");
		expect(config.source).toBe("github-issues");
		expect(config.workflow).toBe("worktree");
		expect(config.source_config.label).toBe("ready");
		expect(config.source_config.pick_from).toBe("open");
		expect(config.source_config.in_progress).toBe("in-progress");
		expect(config.source_config.done).toBe("done");
	});

	it("sets empty team and project", () => {
		const template = getTemplateById("linear-claude")!;
		const config = templateToPartialConfig(template);
		expect(config.source_config.team).toBe("");
		expect(config.source_config.project).toBe("");
	});

	it("sets sensible loop and workspace defaults", () => {
		const template = getTemplateById("linear-claude")!;
		const config = templateToPartialConfig(template);
		expect(config.workspace).toBe(".");
		expect(config.base_branch).toBe("main");
		expect(config.repos).toEqual([]);
		expect(config.loop.cooldown).toBe(10);
	});

	it("sets empty provider_options", () => {
		const template = getTemplateById("github-claude")!;
		const config = templateToPartialConfig(template);
		expect(config.provider_options).toEqual({});
	});

	it("converts jira-claude template correctly", () => {
		const template = getTemplateById("jira-claude")!;
		const config = templateToPartialConfig(template);
		expect(config.provider).toBe("claude");
		expect(config.source).toBe("jira");
		expect(config.source_config.pick_from).toBe("To Do");
		expect(config.source_config.in_progress).toBe("In Progress");
		expect(config.source_config.done).toBe("In Review");
	});

	it("converts linear-gemini template correctly", () => {
		const template = getTemplateById("linear-gemini")!;
		const config = templateToPartialConfig(template);
		expect(config.provider).toBe("gemini");
		expect(config.source).toBe("linear");
		expect(config.workflow).toBe("worktree");
	});
});

describe("CONFIG_TEMPLATES includes common combinations", () => {
	it("includes github-issues + claude", () => {
		const template = getTemplateById("github-claude");
		expect(template).toBeDefined();
		expect(template?.source).toBe("github-issues");
		expect(template?.provider).toBe("claude");
	});

	it("includes linear + claude", () => {
		const template = getTemplateById("linear-claude");
		expect(template).toBeDefined();
		expect(template?.source).toBe("linear");
		expect(template?.provider).toBe("claude");
	});

	it("includes jira + claude", () => {
		const template = getTemplateById("jira-claude");
		expect(template).toBeDefined();
		expect(template?.source).toBe("jira");
		expect(template?.provider).toBe("claude");
	});

	it("includes github-issues + gemini", () => {
		const template = getTemplateById("github-gemini");
		expect(template).toBeDefined();
		expect(template?.source).toBe("github-issues");
		expect(template?.provider).toBe("gemini");
	});

	it("includes linear + gemini", () => {
		const template = getTemplateById("linear-gemini");
		expect(template).toBeDefined();
		expect(template?.source).toBe("linear");
		expect(template?.provider).toBe("gemini");
	});
});
