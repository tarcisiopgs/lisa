import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface QualityScript {
	name: string;
	command: string;
}

export interface TestPattern {
	location: "colocated" | "separate" | "unknown";
	style: "describe-it" | "test" | "mixed" | "unknown";
	mocking: string[];
	example?: string;
}

export interface CodeTool {
	name: string;
	configFile: string;
}

export type ProjectEnvironment = "cli" | "mobile" | "web" | "server" | "library" | "unknown";

export interface ProjectContext {
	qualityScripts: QualityScript[];
	testPattern: TestPattern | null;
	codeTools: CodeTool[];
	projectTree: string;
	environment: ProjectEnvironment;
}

const QUALITY_SCRIPT_NAMES = new Set([
	"lint",
	"typecheck",
	"check",
	"format",
	"test",
	"build",
	"ci",
]);

const IGNORED_DIRS = new Set([
	"node_modules",
	"dist",
	".git",
	".worktrees",
	"coverage",
	".next",
	".nuxt",
	".output",
	"build",
	".cache",
	".turbo",
	".lisa",
]);

export function analyzeProject(cwd: string): ProjectContext {
	return {
		qualityScripts: detectQualityScripts(cwd),
		testPattern: detectTestPattern(cwd),
		codeTools: detectCodeTools(cwd),
		projectTree: generateProjectTree(cwd),
		environment: detectEnvironment(cwd),
	};
}

const CLI_DEPS = [
	"ink",
	"citty",
	"commander",
	"yargs",
	"oclif",
	"meow",
	"cleye",
	"cac",
	"minimist",
	"caporal",
];
const MOBILE_DEPS = ["react-native", "expo", "@react-native", "@expo"];
const WEB_DEPS = [
	"react-dom",
	"next",
	"vue",
	"nuxt",
	"@angular/core",
	"svelte",
	"gatsby",
	"remix",
	"astro",
	"@remix-run/react",
];
const SERVER_DEPS = ["express", "fastify", "koa", "@hapi/hapi", "@nestjs/core", "hono", "elysia"];

export function detectEnvironment(cwd: string): ProjectEnvironment {
	// Non-JS ecosystems
	if (existsSync(join(cwd, "pubspec.yaml"))) return "mobile"; // Flutter
	if (existsSync(join(cwd, "Cargo.toml"))) return "cli"; // Rust
	if (existsSync(join(cwd, "go.mod"))) return "server"; // Go

	const packageJsonPath = join(cwd, "package.json");
	if (!existsSync(packageJsonPath)) return "unknown";

	try {
		const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
			bin?: Record<string, string> | string;
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
		};
		const deps = { ...pkg.dependencies, ...pkg.devDependencies };
		const depNames = Object.keys(deps);

		// CLI: has bin field or uses a known CLI framework
		if (pkg.bin || CLI_DEPS.some((d) => depNames.includes(d))) return "cli";

		// Mobile: react-native, expo, or native project directories
		if (
			MOBILE_DEPS.some((d) => depNames.some((dep) => dep === d || dep.startsWith(`${d}/`))) ||
			existsSync(join(cwd, "android")) ||
			existsSync(join(cwd, "ios"))
		)
			return "mobile";

		// Web: browser-rendering framework
		if (WEB_DEPS.some((d) => depNames.includes(d))) return "web";

		// Server: HTTP server framework
		if (SERVER_DEPS.some((d) => depNames.includes(d))) return "server";

		return "library";
	} catch {
		return "unknown";
	}
}

export function detectQualityScripts(cwd: string): QualityScript[] {
	const packageJsonPath = join(cwd, "package.json");
	if (!existsSync(packageJsonPath)) return [];

	try {
		const content = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
			scripts?: Record<string, string>;
		};
		if (!content.scripts) return [];

		const scripts: QualityScript[] = [];
		for (const [name, command] of Object.entries(content.scripts)) {
			if (QUALITY_SCRIPT_NAMES.has(name)) {
				scripts.push({ name, command });
			}
		}
		return scripts;
	} catch {
		return [];
	}
}

export function detectTestPattern(cwd: string): TestPattern | null {
	const testFiles = findTestFiles(cwd, 3);
	if (testFiles.length === 0) return null;

	const location = inferTestLocation(cwd, testFiles);
	let style: TestPattern["style"] = "unknown";
	const mocking = new Set<string>();
	let example: string | undefined;

	for (const file of testFiles) {
		try {
			const content = readFileSync(file, "utf-8");

			const fileStyle = inferTestStyle(content);
			if (style === "unknown") {
				style = fileStyle;
			} else if (style !== fileStyle && fileStyle !== "unknown") {
				style = "mixed";
			}

			for (const mock of inferMocking(content)) {
				mocking.add(mock);
			}

			if (!example) {
				example = extractTestExample(content, file, cwd);
			}
		} catch {
			// Skip unreadable files
		}
	}

	return {
		location,
		style,
		mocking: [...mocking],
		example,
	};
}

export function detectCodeTools(cwd: string): CodeTool[] {
	const tools: CodeTool[] = [];

	const biomeConfig = ["biome.json", "biome.jsonc"].find((f) => existsSync(join(cwd, f)));
	if (biomeConfig) {
		tools.push({ name: "Biome", configFile: biomeConfig });
	}

	const eslintConfigs = [
		".eslintrc",
		".eslintrc.js",
		".eslintrc.cjs",
		".eslintrc.json",
		".eslintrc.yml",
		".eslintrc.yaml",
		"eslint.config.js",
		"eslint.config.mjs",
		"eslint.config.cjs",
		"eslint.config.ts",
	];
	const eslintConfig = eslintConfigs.find((f) => existsSync(join(cwd, f)));
	if (eslintConfig) {
		tools.push({ name: "ESLint", configFile: eslintConfig });
	}

	const prettierConfigs = [
		".prettierrc",
		".prettierrc.json",
		".prettierrc.yml",
		".prettierrc.yaml",
		".prettierrc.js",
		".prettierrc.cjs",
		".prettierrc.mjs",
		"prettier.config.js",
		"prettier.config.cjs",
		"prettier.config.mjs",
	];
	const prettierConfig = prettierConfigs.find((f) => existsSync(join(cwd, f)));
	if (prettierConfig) {
		tools.push({ name: "Prettier", configFile: prettierConfig });
	}

	return tools;
}

export function generateProjectTree(cwd: string): string {
	const lines: string[] = [];

	try {
		const entries = readdirSync(cwd);
		const filtered = entries
			.filter((e) => !IGNORED_DIRS.has(e) && !e.startsWith("."))
			.sort((a, b) => {
				const aIsDir = isDirectory(join(cwd, a));
				const bIsDir = isDirectory(join(cwd, b));
				if (aIsDir && !bIsDir) return -1;
				if (!aIsDir && bIsDir) return 1;
				return a.localeCompare(b);
			});

		for (const entry of filtered) {
			const fullPath = join(cwd, entry);
			if (isDirectory(fullPath)) {
				lines.push(`${entry}/`);
				try {
					const children = readdirSync(fullPath);
					const filteredChildren = children
						.filter((c) => !IGNORED_DIRS.has(c) && !c.startsWith("."))
						.sort()
						.slice(0, 15);
					for (const child of filteredChildren) {
						const childPath = join(fullPath, child);
						const suffix = isDirectory(childPath) ? "/" : "";
						lines.push(`  ${child}${suffix}`);
					}
					if (children.filter((c) => !IGNORED_DIRS.has(c) && !c.startsWith(".")).length > 15) {
						lines.push("  ...");
					}
				} catch {
					// Skip unreadable directories
				}
			} else {
				lines.push(entry);
			}
		}
	} catch {
		return "";
	}

	return lines.join("\n");
}

const ENVIRONMENT_LABELS: Record<ProjectEnvironment, string> = {
	cli: "CLI (Node.js)",
	mobile: "Mobile (React Native / Flutter / native)",
	web: "Web (browser)",
	server: "Server-side (Node.js)",
	library: "Library",
	unknown: "",
};

const ENVIRONMENT_FORBIDDEN: Partial<Record<ProjectEnvironment, string>> = {
	cli: "Do NOT install browser/DOM packages (`jsdom`, `happy-dom`, `@testing-library/dom`, `@testing-library/react`). All code and tests must run in Node.js only.",
	mobile:
		"Do NOT install browser/DOM packages or web-only libraries. Use only packages compatible with the mobile runtime.",
	server: "Do NOT install browser/DOM packages. Use only Node.js-compatible packages.",
};

export function formatProjectContext(ctx: ProjectContext): string {
	const sections: string[] = [];

	if (ctx.environment !== "unknown" && ctx.environment !== "library") {
		const label = ENVIRONMENT_LABELS[ctx.environment];
		const forbidden = ENVIRONMENT_FORBIDDEN[ctx.environment];
		const note = forbidden ? ` — ${forbidden}` : "";
		sections.push(`### Project Environment\n\n**${label}**${note}`);
	}

	if (ctx.qualityScripts.length > 0) {
		const scriptLines = ctx.qualityScripts
			.map((s) => `- \`${s.name}\`: \`${s.command}\``)
			.join("\n");
		sections.push(`### Quality Scripts\n\n${scriptLines}`);
	}

	if (ctx.testPattern) {
		const tp = ctx.testPattern;
		const details = [
			`- Location: ${tp.location === "colocated" ? "tests are colocated next to source files" : tp.location === "separate" ? "tests are in a separate directory" : "unknown"}`,
			`- Style: ${tp.style === "describe-it" ? "describe/it blocks" : tp.style === "test" ? "top-level test() calls" : tp.style === "mixed" ? "mixed (describe/it and test())" : "unknown"}`,
		];
		if (tp.mocking.length > 0) {
			details.push(`- Mocking: ${tp.mocking.join(", ")}`);
		}
		let block = `### Test Patterns\n\n${details.join("\n")}`;
		if (tp.example) {
			block += `\n\n**Reference test file:**\n\`\`\`typescript\n${tp.example}\n\`\`\``;
		}
		sections.push(block);
	}

	if (ctx.codeTools.length > 0) {
		const toolLines = ctx.codeTools
			.map((t) => `- **${t.name}** (config: \`${t.configFile}\`)`)
			.join("\n");
		sections.push(`### Code Tools\n\n${toolLines}`);
	}

	if (ctx.projectTree) {
		sections.push(`### Project Structure\n\n\`\`\`\n${ctx.projectTree}\n\`\`\``);
	}

	if (sections.length === 0) return "";
	return `## Project Context\n\n${sections.join("\n\n")}`;
}

// --- Internal helpers ---

function findTestFiles(cwd: string, maxFiles: number): string[] {
	const results: string[] = [];
	walkForTests(cwd, cwd, results, maxFiles, 0);
	return results;
}

function walkForTests(
	root: string,
	dir: string,
	results: string[],
	maxFiles: number,
	depth: number,
): void {
	if (results.length >= maxFiles || depth > 5) return;

	try {
		const entries = readdirSync(dir);
		for (const entry of entries) {
			if (results.length >= maxFiles) return;
			if (IGNORED_DIRS.has(entry)) continue;

			const fullPath = join(dir, entry);
			if (isDirectory(fullPath)) {
				walkForTests(root, fullPath, results, maxFiles, depth + 1);
			} else if (
				entry.endsWith(".test.ts") ||
				entry.endsWith(".spec.ts") ||
				entry.endsWith(".test.tsx") ||
				entry.endsWith(".spec.tsx") ||
				entry.endsWith(".test.js") ||
				entry.endsWith(".spec.js")
			) {
				results.push(fullPath);
			}
		}
	} catch {
		// Skip unreadable directories
	}
}

function inferTestLocation(cwd: string, testFiles: string[]): TestPattern["location"] {
	let colocated = 0;
	let separate = 0;

	for (const file of testFiles) {
		const rel = relative(cwd, file);
		const parts = rel.split("/");
		if (
			parts.some(
				(p) =>
					p === "__tests__" || p === "tests" || p === "test" || p === "spec" || p === "__specs__",
			)
		) {
			separate++;
		} else {
			colocated++;
		}
	}

	if (colocated > 0 && separate === 0) return "colocated";
	if (separate > 0 && colocated === 0) return "separate";
	if (colocated > 0 && separate > 0) return "colocated";
	return "unknown";
}

function inferTestStyle(content: string): TestPattern["style"] {
	const hasDescribe = /\bdescribe\s*\(/.test(content);
	const hasIt = /\bit\s*\(/.test(content);
	const hasTopLevelTest = /\btest\s*\(/.test(content);

	if (hasDescribe && hasIt) return "describe-it";
	if (hasTopLevelTest && !hasDescribe) return "test";
	if (hasDescribe || hasIt) return "describe-it";
	return "unknown";
}

function inferMocking(content: string): string[] {
	const mocks: string[] = [];
	if (/\bvi\.(mock|fn|spyOn)\b/.test(content)) mocks.push("vi.mock/vi.fn");
	if (/\bjest\.(mock|fn|spyOn)\b/.test(content)) mocks.push("jest.mock/jest.fn");
	if (/\bfixture/.test(content)) mocks.push("fixtures");
	return mocks;
}

function extractTestExample(content: string, filePath: string, cwd: string): string | undefined {
	const lines = content.split("\n");
	// Take the first ~30 lines as a reference example
	const snippet = lines.slice(0, 30).join("\n").trim();
	if (snippet.length < 10) return undefined;

	const relPath = relative(cwd, filePath);
	return `// ${relPath}\n${snippet}`;
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}
