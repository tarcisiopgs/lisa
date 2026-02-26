import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	analyzeProject,
	detectCodeTools,
	detectEnvironment,
	detectQualityScripts,
	detectTestPattern,
	formatProjectContext,
	generateProjectTree,
} from "./context.js";

describe("detectQualityScripts", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "lisa-ctx-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns empty array when no package.json", () => {
		expect(detectQualityScripts(tmpDir)).toEqual([]);
	});

	it("returns empty array when package.json has no scripts", () => {
		writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }));
		expect(detectQualityScripts(tmpDir)).toEqual([]);
	});

	it("detects quality scripts from package.json", () => {
		writeFileSync(
			join(tmpDir, "package.json"),
			JSON.stringify({
				scripts: {
					lint: "biome lint",
					typecheck: "tsc --noEmit",
					test: "vitest run",
					build: "tsup",
					dev: "tsx src/index.ts",
					start: "node dist/index.js",
				},
			}),
		);
		const scripts = detectQualityScripts(tmpDir);
		expect(scripts).toEqual([
			{ name: "lint", command: "biome lint" },
			{ name: "typecheck", command: "tsc --noEmit" },
			{ name: "test", command: "vitest run" },
			{ name: "build", command: "tsup" },
		]);
	});

	it("detects all recognized quality script names", () => {
		writeFileSync(
			join(tmpDir, "package.json"),
			JSON.stringify({
				scripts: {
					lint: "eslint .",
					typecheck: "tsc --noEmit",
					check: "biome check",
					format: "prettier --write .",
					test: "jest",
					build: "webpack",
					ci: "npm run lint && npm run test",
				},
			}),
		);
		const scripts = detectQualityScripts(tmpDir);
		expect(scripts).toHaveLength(7);
		expect(scripts.map((s) => s.name)).toEqual([
			"lint",
			"typecheck",
			"check",
			"format",
			"test",
			"build",
			"ci",
		]);
	});

	it("ignores non-quality scripts", () => {
		writeFileSync(
			join(tmpDir, "package.json"),
			JSON.stringify({
				scripts: {
					dev: "tsx src/index.ts",
					start: "node dist/index.js",
					prepare: "husky",
				},
			}),
		);
		expect(detectQualityScripts(tmpDir)).toEqual([]);
	});

	it("returns empty array for invalid JSON", () => {
		writeFileSync(join(tmpDir, "package.json"), "not valid json");
		expect(detectQualityScripts(tmpDir)).toEqual([]);
	});
});

describe("detectTestPattern", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "lisa-ctx-"));
		mkdirSync(join(tmpDir, "src"), { recursive: true });
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns null when no test files found", () => {
		writeFileSync(join(tmpDir, "src", "index.ts"), "export const a = 1;");
		expect(detectTestPattern(tmpDir)).toBeNull();
	});

	it("detects colocated test files", () => {
		writeFileSync(
			join(tmpDir, "src", "utils.test.ts"),
			'import { describe, it, expect } from "vitest";\n\ndescribe("utils", () => {\n  it("works", () => {\n    expect(true).toBe(true);\n  });\n});',
		);
		const pattern = detectTestPattern(tmpDir);
		expect(pattern).not.toBeNull();
		expect(pattern?.location).toBe("colocated");
	});

	it("detects separate test directory", () => {
		mkdirSync(join(tmpDir, "__tests__"), { recursive: true });
		writeFileSync(
			join(tmpDir, "__tests__", "utils.test.ts"),
			'import { describe, it, expect } from "vitest";\n\ndescribe("utils", () => {\n  it("works", () => {\n    expect(true).toBe(true);\n  });\n});',
		);
		const pattern = detectTestPattern(tmpDir);
		expect(pattern).not.toBeNull();
		expect(pattern?.location).toBe("separate");
	});

	it("detects describe/it style", () => {
		writeFileSync(
			join(tmpDir, "src", "utils.test.ts"),
			'import { describe, it, expect } from "vitest";\n\ndescribe("utils", () => {\n  it("works", () => {\n    expect(true).toBe(true);\n  });\n});',
		);
		const pattern = detectTestPattern(tmpDir);
		expect(pattern?.style).toBe("describe-it");
	});

	it("detects top-level test() style", () => {
		writeFileSync(
			join(tmpDir, "src", "utils.test.ts"),
			'import { test, expect } from "vitest";\n\ntest("it works", () => {\n  expect(true).toBe(true);\n});',
		);
		const pattern = detectTestPattern(tmpDir);
		expect(pattern?.style).toBe("test");
	});

	it("detects vi.mock mocking", () => {
		writeFileSync(
			join(tmpDir, "src", "utils.test.ts"),
			'import { describe, it, expect, vi } from "vitest";\n\nvi.mock("./dep.js");\n\ndescribe("utils", () => {\n  it("works", () => {\n    const fn = vi.fn();\n    expect(fn).not.toHaveBeenCalled();\n  });\n});',
		);
		const pattern = detectTestPattern(tmpDir);
		expect(pattern?.mocking).toContain("vi.mock/vi.fn");
	});

	it("detects jest.mock mocking", () => {
		writeFileSync(
			join(tmpDir, "src", "utils.test.ts"),
			'import { describe, it, expect } from "vitest";\n\njest.mock("./dep.js");\n\ndescribe("utils", () => {\n  it("works", () => {\n    expect(true).toBe(true);\n  });\n});',
		);
		const pattern = detectTestPattern(tmpDir);
		expect(pattern?.mocking).toContain("jest.mock/jest.fn");
	});

	it("detects fixture usage", () => {
		writeFileSync(
			join(tmpDir, "src", "utils.test.ts"),
			'import { describe, it, expect } from "vitest";\nimport fixture from "./fixtures/data.json";\n\ndescribe("utils", () => {\n  it("works with fixture", () => {\n    expect(fixture).toBeDefined();\n  });\n});',
		);
		const pattern = detectTestPattern(tmpDir);
		expect(pattern?.mocking).toContain("fixtures");
	});

	it("includes example from first test file", () => {
		writeFileSync(
			join(tmpDir, "src", "utils.test.ts"),
			'import { describe, it, expect } from "vitest";\n\ndescribe("utils", () => {\n  it("works", () => {\n    expect(true).toBe(true);\n  });\n});',
		);
		const pattern = detectTestPattern(tmpDir);
		expect(pattern?.example).toContain("describe");
		expect(pattern?.example).toContain("src/utils.test.ts");
	});

	it("limits to 3 test files", () => {
		for (let i = 0; i < 5; i++) {
			writeFileSync(
				join(tmpDir, "src", `mod${i}.test.ts`),
				`import { test, expect } from "vitest";\n\ntest("mod${i}", () => {\n  expect(true).toBe(true);\n});`,
			);
		}
		// Should not throw and should return a valid pattern
		const pattern = detectTestPattern(tmpDir);
		expect(pattern).not.toBeNull();
	});

	it("detects .spec.ts files", () => {
		writeFileSync(
			join(tmpDir, "src", "utils.spec.ts"),
			'import { describe, it, expect } from "vitest";\n\ndescribe("utils", () => {\n  it("works", () => {\n    expect(true).toBe(true);\n  });\n});',
		);
		const pattern = detectTestPattern(tmpDir);
		expect(pattern).not.toBeNull();
		expect(pattern?.location).toBe("colocated");
	});
});

describe("detectCodeTools", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "lisa-ctx-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns empty array when no code tools found", () => {
		expect(detectCodeTools(tmpDir)).toEqual([]);
	});

	it("detects biome.json", () => {
		writeFileSync(join(tmpDir, "biome.json"), "{}");
		const tools = detectCodeTools(tmpDir);
		expect(tools).toEqual([{ name: "Biome", configFile: "biome.json" }]);
	});

	it("detects biome.jsonc", () => {
		writeFileSync(join(tmpDir, "biome.jsonc"), "{}");
		const tools = detectCodeTools(tmpDir);
		expect(tools).toEqual([{ name: "Biome", configFile: "biome.jsonc" }]);
	});

	it("detects .eslintrc.json", () => {
		writeFileSync(join(tmpDir, ".eslintrc.json"), "{}");
		const tools = detectCodeTools(tmpDir);
		expect(tools).toEqual([{ name: "ESLint", configFile: ".eslintrc.json" }]);
	});

	it("detects eslint.config.js", () => {
		writeFileSync(join(tmpDir, "eslint.config.js"), "export default {};");
		const tools = detectCodeTools(tmpDir);
		expect(tools).toEqual([{ name: "ESLint", configFile: "eslint.config.js" }]);
	});

	it("detects .prettierrc", () => {
		writeFileSync(join(tmpDir, ".prettierrc"), "{}");
		const tools = detectCodeTools(tmpDir);
		expect(tools).toEqual([{ name: "Prettier", configFile: ".prettierrc" }]);
	});

	it("detects prettier.config.js", () => {
		writeFileSync(join(tmpDir, "prettier.config.js"), "export default {};");
		const tools = detectCodeTools(tmpDir);
		expect(tools).toEqual([{ name: "Prettier", configFile: "prettier.config.js" }]);
	});

	it("detects multiple tools", () => {
		writeFileSync(join(tmpDir, "biome.json"), "{}");
		writeFileSync(join(tmpDir, ".eslintrc.json"), "{}");
		writeFileSync(join(tmpDir, ".prettierrc"), "{}");
		const tools = detectCodeTools(tmpDir);
		expect(tools).toHaveLength(3);
		expect(tools.map((t) => t.name)).toEqual(["Biome", "ESLint", "Prettier"]);
	});
});

describe("generateProjectTree", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "lisa-ctx-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns empty string for empty directory", () => {
		expect(generateProjectTree(tmpDir)).toBe("");
	});

	it("lists top-level files and directories", () => {
		mkdirSync(join(tmpDir, "src"));
		writeFileSync(join(tmpDir, "package.json"), "{}");
		writeFileSync(join(tmpDir, "tsconfig.json"), "{}");

		const tree = generateProjectTree(tmpDir);
		expect(tree).toContain("src/");
		expect(tree).toContain("package.json");
		expect(tree).toContain("tsconfig.json");
	});

	it("shows one level of children for directories", () => {
		mkdirSync(join(tmpDir, "src"));
		writeFileSync(join(tmpDir, "src", "index.ts"), "");
		writeFileSync(join(tmpDir, "src", "cli.ts"), "");

		const tree = generateProjectTree(tmpDir);
		expect(tree).toContain("src/");
		expect(tree).toContain("  index.ts");
		expect(tree).toContain("  cli.ts");
	});

	it("ignores node_modules and dist", () => {
		mkdirSync(join(tmpDir, "node_modules"));
		mkdirSync(join(tmpDir, "dist"));
		mkdirSync(join(tmpDir, "src"));
		writeFileSync(join(tmpDir, "node_modules", "dep.js"), "");
		writeFileSync(join(tmpDir, "dist", "index.js"), "");
		writeFileSync(join(tmpDir, "src", "index.ts"), "");

		const tree = generateProjectTree(tmpDir);
		expect(tree).not.toContain("node_modules");
		expect(tree).not.toContain("dist");
		expect(tree).toContain("src/");
	});

	it("ignores hidden directories", () => {
		mkdirSync(join(tmpDir, ".git"));
		mkdirSync(join(tmpDir, "src"));
		writeFileSync(join(tmpDir, ".git", "config"), "");

		const tree = generateProjectTree(tmpDir);
		expect(tree).not.toContain(".git");
		expect(tree).toContain("src/");
	});

	it("marks subdirectories with trailing slash", () => {
		mkdirSync(join(tmpDir, "src"));
		mkdirSync(join(tmpDir, "src", "providers"));

		const tree = generateProjectTree(tmpDir);
		expect(tree).toContain("src/");
		expect(tree).toContain("  providers/");
	});

	it("truncates large directories with ellipsis", () => {
		mkdirSync(join(tmpDir, "src"));
		for (let i = 0; i < 20; i++) {
			writeFileSync(join(tmpDir, "src", `file${i.toString().padStart(2, "0")}.ts`), "");
		}

		const tree = generateProjectTree(tmpDir);
		expect(tree).toContain("...");
	});
});

describe("analyzeProject", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "lisa-ctx-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns complete ProjectContext", () => {
		mkdirSync(join(tmpDir, "src"));
		writeFileSync(
			join(tmpDir, "package.json"),
			JSON.stringify({
				scripts: { lint: "eslint .", test: "vitest run" },
			}),
		);
		writeFileSync(join(tmpDir, "biome.json"), "{}");
		writeFileSync(
			join(tmpDir, "src", "utils.test.ts"),
			'import { describe, it, expect } from "vitest";\n\ndescribe("utils", () => {\n  it("works", () => {\n    expect(true).toBe(true);\n  });\n});',
		);

		const ctx = analyzeProject(tmpDir);
		expect(ctx.qualityScripts).toHaveLength(2);
		expect(ctx.testPattern).not.toBeNull();
		expect(ctx.codeTools).toHaveLength(1);
		expect(ctx.projectTree).toContain("src/");
		expect(ctx.environment).toBe("library");
	});

	it("handles empty project", () => {
		const ctx = analyzeProject(tmpDir);
		expect(ctx.qualityScripts).toEqual([]);
		expect(ctx.testPattern).toBeNull();
		expect(ctx.codeTools).toEqual([]);
		expect(ctx.projectTree).toBe("");
		expect(ctx.environment).toBe("unknown");
	});
});

describe("detectEnvironment", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "lisa-env-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns unknown when no package.json and no recognized files", () => {
		expect(detectEnvironment(tmpDir)).toBe("unknown");
	});

	it("detects CLI via bin field in package.json", () => {
		writeFileSync(
			join(tmpDir, "package.json"),
			JSON.stringify({ bin: { mytool: "dist/index.js" } }),
		);
		expect(detectEnvironment(tmpDir)).toBe("cli");
	});

	it("detects CLI via ink dependency", () => {
		writeFileSync(
			join(tmpDir, "package.json"),
			JSON.stringify({ dependencies: { ink: "^5.0.0" } }),
		);
		expect(detectEnvironment(tmpDir)).toBe("cli");
	});

	it("detects CLI via commander dependency", () => {
		writeFileSync(
			join(tmpDir, "package.json"),
			JSON.stringify({ dependencies: { commander: "^11.0.0" } }),
		);
		expect(detectEnvironment(tmpDir)).toBe("cli");
	});

	it("detects mobile via react-native dependency", () => {
		writeFileSync(
			join(tmpDir, "package.json"),
			JSON.stringify({ dependencies: { "react-native": "^0.73.0" } }),
		);
		expect(detectEnvironment(tmpDir)).toBe("mobile");
	});

	it("detects mobile via ios directory", () => {
		mkdirSync(join(tmpDir, "ios"));
		writeFileSync(join(tmpDir, "package.json"), JSON.stringify({}));
		expect(detectEnvironment(tmpDir)).toBe("mobile");
	});

	it("detects mobile via Flutter pubspec.yaml", () => {
		writeFileSync(join(tmpDir, "pubspec.yaml"), "name: myapp\n");
		expect(detectEnvironment(tmpDir)).toBe("mobile");
	});

	it("detects web via react-dom dependency", () => {
		writeFileSync(
			join(tmpDir, "package.json"),
			JSON.stringify({ dependencies: { "react-dom": "^18.0.0" } }),
		);
		expect(detectEnvironment(tmpDir)).toBe("web");
	});

	it("detects web via next dependency", () => {
		writeFileSync(
			join(tmpDir, "package.json"),
			JSON.stringify({ dependencies: { next: "^14.0.0" } }),
		);
		expect(detectEnvironment(tmpDir)).toBe("web");
	});

	it("detects server via express dependency", () => {
		writeFileSync(
			join(tmpDir, "package.json"),
			JSON.stringify({ dependencies: { express: "^4.0.0" } }),
		);
		expect(detectEnvironment(tmpDir)).toBe("server");
	});

	it("detects server via fastify dependency", () => {
		writeFileSync(
			join(tmpDir, "package.json"),
			JSON.stringify({ dependencies: { fastify: "^4.0.0" } }),
		);
		expect(detectEnvironment(tmpDir)).toBe("server");
	});

	it("returns library when package.json has no recognized deps", () => {
		writeFileSync(
			join(tmpDir, "package.json"),
			JSON.stringify({ dependencies: { yaml: "^2.0.0" } }),
		);
		expect(detectEnvironment(tmpDir)).toBe("library");
	});

	it("CLI takes priority over web when bin is present", () => {
		writeFileSync(
			join(tmpDir, "package.json"),
			JSON.stringify({
				bin: { mytool: "dist/index.js" },
				dependencies: { "react-dom": "^18.0.0" },
			}),
		);
		expect(detectEnvironment(tmpDir)).toBe("cli");
	});
});

describe("formatProjectContext", () => {
	it("returns empty string for empty context", () => {
		const result = formatProjectContext({
			qualityScripts: [],
			testPattern: null,
			codeTools: [],
			projectTree: "",
			environment: "unknown",
		});
		expect(result).toBe("");
	});

	it("includes quality scripts section", () => {
		const result = formatProjectContext({
			qualityScripts: [
				{ name: "lint", command: "biome lint" },
				{ name: "test", command: "vitest run" },
			],
			testPattern: null,
			codeTools: [],
			projectTree: "",
			environment: "unknown",
		});
		expect(result).toContain("## Project Context");
		expect(result).toContain("### Quality Scripts");
		expect(result).toContain("`lint`: `biome lint`");
		expect(result).toContain("`test`: `vitest run`");
	});

	it("includes test pattern section", () => {
		const result = formatProjectContext({
			qualityScripts: [],
			testPattern: {
				location: "colocated",
				style: "describe-it",
				mocking: ["vi.mock/vi.fn"],
				example: '// src/utils.test.ts\nimport { describe, it } from "vitest";',
			},
			codeTools: [],
			projectTree: "",
			environment: "unknown",
		});
		expect(result).toContain("### Test Patterns");
		expect(result).toContain("colocated next to source files");
		expect(result).toContain("describe/it blocks");
		expect(result).toContain("vi.mock/vi.fn");
		expect(result).toContain("Reference test file");
	});

	it("includes code tools section", () => {
		const result = formatProjectContext({
			qualityScripts: [],
			testPattern: null,
			codeTools: [
				{ name: "Biome", configFile: "biome.json" },
				{ name: "ESLint", configFile: ".eslintrc.json" },
			],
			projectTree: "",
			environment: "unknown",
		});
		expect(result).toContain("### Code Tools");
		expect(result).toContain("**Biome** (config: `biome.json`)");
		expect(result).toContain("**ESLint** (config: `.eslintrc.json`)");
	});

	it("includes project structure section", () => {
		const result = formatProjectContext({
			qualityScripts: [],
			testPattern: null,
			codeTools: [],
			projectTree: "src/\n  index.ts\npackage.json",
			environment: "unknown",
		});
		expect(result).toContain("### Project Structure");
		expect(result).toContain("src/");
		expect(result).toContain("index.ts");
	});

	it("includes all sections when context is complete", () => {
		const result = formatProjectContext({
			qualityScripts: [{ name: "lint", command: "eslint ." }],
			testPattern: {
				location: "separate",
				style: "test",
				mocking: [],
			},
			codeTools: [{ name: "ESLint", configFile: ".eslintrc.json" }],
			projectTree: "src/\npackage.json",
			environment: "unknown",
		});
		expect(result).toContain("### Quality Scripts");
		expect(result).toContain("### Test Patterns");
		expect(result).toContain("### Code Tools");
		expect(result).toContain("### Project Structure");
	});

	it("formats separate test location correctly", () => {
		const result = formatProjectContext({
			qualityScripts: [],
			testPattern: {
				location: "separate",
				style: "test",
				mocking: [],
			},
			codeTools: [],
			projectTree: "",
			environment: "unknown",
		});
		expect(result).toContain("tests are in a separate directory");
	});

	it("formats test() style correctly", () => {
		const result = formatProjectContext({
			qualityScripts: [],
			testPattern: {
				location: "colocated",
				style: "test",
				mocking: [],
			},
			codeTools: [],
			projectTree: "",
			environment: "unknown",
		});
		expect(result).toContain("top-level test() calls");
	});

	it("formats mixed style correctly", () => {
		const result = formatProjectContext({
			qualityScripts: [],
			testPattern: {
				location: "colocated",
				style: "mixed",
				mocking: [],
			},
			codeTools: [],
			projectTree: "",
			environment: "unknown",
		});
		expect(result).toContain("mixed (describe/it and test())");
	});

	it("includes CLI environment section with forbidden packages note", () => {
		const result = formatProjectContext({
			qualityScripts: [],
			testPattern: null,
			codeTools: [],
			projectTree: "",
			environment: "cli",
		});
		expect(result).toContain("### Project Environment");
		expect(result).toContain("CLI (Node.js)");
		expect(result).toContain("jsdom");
	});

	it("includes mobile environment section", () => {
		const result = formatProjectContext({
			qualityScripts: [],
			testPattern: null,
			codeTools: [],
			projectTree: "",
			environment: "mobile",
		});
		expect(result).toContain("### Project Environment");
		expect(result).toContain("Mobile");
	});

	it("does not include environment section for unknown or library", () => {
		for (const env of ["unknown", "library"] as const) {
			const result = formatProjectContext({
				qualityScripts: [{ name: "lint", command: "eslint ." }],
				testPattern: null,
				codeTools: [],
				projectTree: "",
				environment: env,
			});
			expect(result).not.toContain("### Project Environment");
		}
	});
});
