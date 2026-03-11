# Stack-Aware Prompt Injection Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect project stack tools (ORMs, API codegen) and inject contextual instructions into agent prompts — either "run this command" or "create files manually" — based on infrastructure availability.

**Architecture:** New `discoverStackTools()` in `discovery.ts` detects 16 tools across 6 languages. New `resolveInfraStatus()` in `lifecycle.ts` determines infra availability. New `buildStackInstructions()` in `prompt.ts` generates the prompt block. Sessions use fallback instead of abort on lifecycle failure.

**Tech Stack:** TypeScript, vitest, existing Lisa infrastructure (discovery.ts, lifecycle.ts, prompt.ts, session files)

---

## Chunk 1: Stack Detection

### Task 1: StackTool interface and discoverStackTools()

**Files:**
- Modify: `src/session/discovery.ts:1-20` (add interface and new function)
- Test: `src/session/discovery.test.ts`

- [ ] **Step 1: Write the failing test for StackTool detection — Prisma**

Add to `src/session/discovery.test.ts`:

```typescript
import {
	discoverDockerCompose,
	discoverEnvFile,
	discoverInfra,
	discoverSetupCommands,
	discoverStackTools,
} from "./discovery.js";

// ... existing tests ...

describe("discoverStackTools", () => {
	it("returns empty array when no tools detected", () => {
		expect(discoverStackTools(tmpDir)).toEqual([]);
	});

	it("detects Prisma", () => {
		mkdirSync(join(tmpDir, "prisma"), { recursive: true });
		writeFileSync(join(tmpDir, "prisma", "schema.prisma"), "generator client {}");

		const tools = discoverStackTools(tmpDir);
		expect(tools).toHaveLength(1);
		expect(tools[0]).toMatchObject({
			name: "prisma",
			category: "orm",
			language: "typescript",
			configFile: "prisma/schema.prisma",
			infraCommand: "npx prisma db push",
		});
		expect(tools[0]?.manualHint).toContain("prisma/migrations/");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/session/discovery.test.ts -t "discoverStackTools"`
Expected: FAIL with "discoverStackTools is not a function" or similar

- [ ] **Step 3: Write the StackTool interface and initial discoverStackTools()**

Add to `src/session/discovery.ts` after `InfraConfig`:

```typescript
export interface StackTool {
	name: string;
	category: "orm" | "api-codegen" | "other";
	language: string;
	configFile: string;
	infraCommand?: string;
	manualHint: string;
}

interface StackToolDef {
	name: string;
	category: StackTool["category"];
	language: string;
	detect: (cwd: string) => string | null; // returns configFile path or null
	infraCommand?: string;
	manualHint: string;
}

const STACK_TOOL_DEFS: StackToolDef[] = [
	// TypeScript/JavaScript ORMs
	{
		name: "prisma",
		category: "orm",
		language: "typescript",
		detect: (cwd) =>
			existsSync(join(cwd, "prisma", "schema.prisma")) ? "prisma/schema.prisma" : null,
		infraCommand: "npx prisma db push",
		manualHint:
			"Create migration files manually in `prisma/migrations/` following the existing pattern. Reference `prisma/schema.prisma` for the current schema.",
	},
	{
		name: "drizzle",
		category: "orm",
		language: "typescript",
		detect: (cwd) => {
			for (const f of ["drizzle.config.ts", "drizzle.config.js", "drizzle.config.mjs"]) {
				if (existsSync(join(cwd, f))) return f;
			}
			return null;
		},
		infraCommand: "npx drizzle-kit push",
		manualHint:
			"Create SQL migration files in the `drizzle/` directory (or the configured migrations folder) following the existing naming pattern.",
	},
	{
		name: "typeorm",
		category: "orm",
		language: "typescript",
		detect: (cwd) => {
			if (existsSync(join(cwd, "data-source.ts"))) return "data-source.ts";
			if (existsSync(join(cwd, "ormconfig.ts"))) return "ormconfig.ts";
			if (existsSync(join(cwd, "ormconfig.js"))) return "ormconfig.js";
			return null;
		},
		infraCommand: "npx typeorm migration:run",
		manualHint:
			"Create migration files in `src/migrations/` using TypeORM migration class format.",
	},
	{
		name: "sequelize",
		category: "orm",
		language: "typescript",
		detect: (cwd) => {
			if (existsSync(join(cwd, ".sequelizerc"))) return ".sequelizerc";
			if (existsSync(join(cwd, "config", "config.json"))) return "config/config.json";
			return null;
		},
		infraCommand: "npx sequelize-cli db:migrate",
		manualHint:
			"Create migration files in `migrations/` following the Sequelize timestamp naming pattern.",
	},
	// Ruby
	{
		name: "rails",
		category: "orm",
		language: "ruby",
		detect: (cwd) => {
			if (existsSync(join(cwd, "Gemfile")) && existsSync(join(cwd, "db", "migrate")))
				return "Gemfile";
			return null;
		},
		infraCommand: "bundle exec rails db:migrate",
		manualHint:
			"Create migration files in `db/migrate/` with timestamp prefix (e.g., `YYYYMMDDHHMMSS_migration_name.rb`). Use ActiveRecord migration DSL.",
	},
	// Python
	{
		name: "django",
		category: "orm",
		language: "python",
		detect: (cwd) => {
			if (!existsSync(join(cwd, "manage.py"))) return null;
			// Check for any app with migrations/
			try {
				const entries = readdirSync(cwd);
				for (const entry of entries) {
					if (existsSync(join(cwd, entry, "migrations", "__init__.py"))) return "manage.py";
				}
			} catch {}
			return null;
		},
		infraCommand: "python manage.py migrate",
		manualHint:
			"Create migration files in the app's `migrations/` directory following Django migration format. Include a `Migration` class with `dependencies` and `operations`.",
	},
	{
		name: "alembic",
		category: "orm",
		language: "python",
		detect: (cwd) =>
			existsSync(join(cwd, "alembic.ini")) ? "alembic.ini" : null,
		infraCommand: "alembic upgrade head",
		manualHint:
			"Create migration files in `alembic/versions/` following the existing pattern with `upgrade()` and `downgrade()` functions.",
	},
	// PHP
	{
		name: "laravel",
		category: "orm",
		language: "php",
		detect: (cwd) => {
			if (existsSync(join(cwd, "artisan")) && existsSync(join(cwd, "database", "migrations")))
				return "artisan";
			return null;
		},
		infraCommand: "php artisan migrate",
		manualHint:
			"Create migration files in `database/migrations/` with timestamp prefix. Use Laravel migration blueprint DSL.",
	},
	// Java
	{
		name: "flyway",
		category: "orm",
		language: "java",
		detect: (cwd) => {
			if (existsSync(join(cwd, "flyway.conf"))) return "flyway.conf";
			if (existsSync(join(cwd, "src", "main", "resources", "db", "migration")))
				return "src/main/resources/db/migration";
			return null;
		},
		infraCommand: "flyway migrate",
		manualHint:
			"Create SQL migration files in `db/migration/` (or `src/main/resources/db/migration/`) with versioned naming: `V{N}__{description}.sql`.",
	},
	{
		name: "liquibase",
		category: "orm",
		language: "java",
		detect: (cwd) => {
			if (existsSync(join(cwd, "liquibase.properties"))) return "liquibase.properties";
			for (const ext of ["xml", "yaml", "yml", "json"]) {
				if (existsSync(join(cwd, `changelog.${ext}`))) return `changelog.${ext}`;
			}
			return null;
		},
		infraCommand: "liquibase update",
		manualHint:
			"Add changesets to the changelog file following the existing format (XML/YAML/JSON).",
	},
	// Go
	{
		name: "goose",
		category: "orm",
		language: "go",
		detect: (cwd) => {
			if (!existsSync(join(cwd, "go.mod"))) return null;
			try {
				const content = readFileSync(join(cwd, "go.mod"), "utf-8");
				if (content.includes("pressly/goose")) return "go.mod";
			} catch {}
			return null;
		},
		infraCommand: "goose up",
		manualHint:
			"Create SQL or Go migration files in the migrations directory with sequential numbering.",
	},
	{
		name: "golang-migrate",
		category: "orm",
		language: "go",
		detect: (cwd) => {
			if (!existsSync(join(cwd, "go.mod"))) return null;
			try {
				const content = readFileSync(join(cwd, "go.mod"), "utf-8");
				if (content.includes("golang-migrate/migrate")) return "go.mod";
			} catch {}
			return null;
		},
		infraCommand: "migrate up",
		manualHint:
			"Create paired SQL migration files (`{N}_name.up.sql` and `{N}_name.down.sql`) in the migrations directory.",
	},
	// API Codegen (TypeScript)
	{
		name: "orval",
		category: "api-codegen",
		language: "typescript",
		detect: (cwd) => {
			for (const f of ["orval.config.ts", "orval.config.js", "orval.config.mjs", ".orvalrc", ".orvalrc.json", ".orvalrc.js", ".orvalrc.ts"]) {
				if (existsSync(join(cwd, f))) return f;
			}
			return null;
		},
		infraCommand: "npx orval",
		manualHint:
			"Create TypeScript types and API client functions manually based on the OpenAPI spec file in the project. Check for existing generated types to follow the same patterns.",
	},
	{
		name: "kubb",
		category: "api-codegen",
		language: "typescript",
		detect: (cwd) => {
			for (const f of ["kubb.config.ts", "kubb.config.js", "kubb.config.mjs"]) {
				if (existsSync(join(cwd, f))) return f;
			}
			return null;
		},
		infraCommand: "npx kubb generate",
		manualHint:
			"Create TypeScript types and API client functions manually based on the OpenAPI spec file in the project.",
	},
	{
		name: "graphql-codegen",
		category: "api-codegen",
		language: "typescript",
		detect: (cwd) => {
			for (const f of ["codegen.ts", "codegen.js", "codegen.yml", "codegen.yaml"]) {
				if (existsSync(join(cwd, f))) return f;
			}
			return null;
		},
		infraCommand: "npx graphql-codegen",
		manualHint:
			"Create TypeScript types manually based on the GraphQL schema files in the project.",
	},
	// Multi-language
	{
		name: "protobuf",
		category: "other",
		language: "multi",
		detect: (cwd) => {
			if (existsSync(join(cwd, "buf.yaml")) || existsSync(join(cwd, "buf.gen.yaml")))
				return existsSync(join(cwd, "buf.yaml")) ? "buf.yaml" : "buf.gen.yaml";
			return null;
		},
		infraCommand: "buf generate",
		manualHint:
			"Create stubs and types manually following the `.proto` file definitions in the project.",
	},
];

/**
 * Detect stack tools (ORMs, API codegen, etc.) present in the project.
 * Returns metadata about each detected tool including commands and manual hints.
 */
export function discoverStackTools(cwd: string): StackTool[] {
	const tools: StackTool[] = [];

	for (const def of STACK_TOOL_DEFS) {
		const configFile = def.detect(cwd);
		if (!configFile) continue;

		tools.push({
			name: def.name,
			category: def.category,
			language: def.language,
			configFile,
			infraCommand: def.infraCommand,
			manualHint: enrichManualHint(def, cwd),
		});
	}

	return tools;
}

/**
 * Enrich a manual hint with real project paths and patterns found on disk.
 */
function enrichManualHint(def: StackToolDef, cwd: string): string {
	let hint = def.manualHint;

	// Try to find existing migration files to reference
	const migrationDirs = findMigrationDirs(def.name, cwd);
	if (migrationDirs.length > 0) {
		const existing = listRecentFiles(join(cwd, migrationDirs[0]!), 3);
		if (existing.length > 0) {
			hint += `\nExisting files: ${existing.map((f) => `\`${migrationDirs[0]}/${f}\``).join(", ")}`;
		}
	}

	return hint;
}

function findMigrationDirs(toolName: string, cwd: string): string[] {
	const candidates: Record<string, string[]> = {
		prisma: ["prisma/migrations"],
		drizzle: ["drizzle", "drizzle/migrations", "migrations"],
		typeorm: ["src/migrations", "migrations"],
		sequelize: ["migrations"],
		rails: ["db/migrate"],
		django: [], // dynamic — detected per-app
		alembic: ["alembic/versions"],
		laravel: ["database/migrations"],
		flyway: ["db/migration", "src/main/resources/db/migration"],
		liquibase: [],
		goose: ["migrations", "db/migrations"],
		"golang-migrate": ["migrations", "db/migrations"],
	};

	return (candidates[toolName] ?? []).filter((dir) => existsSync(join(cwd, dir)));
}

function listRecentFiles(dir: string, max: number): string[] {
	try {
		const files = readdirSync(dir)
			.filter((f) => !f.startsWith("."))
			.sort()
			.reverse()
			.slice(0, max)
			.reverse();
		return files;
	} catch {
		return [];
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/session/discovery.test.ts -t "discoverStackTools"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/session/discovery.ts src/session/discovery.test.ts
git commit -m "feat: add discoverStackTools() with Prisma detection"
```

### Task 2: Tests for remaining stack tools

**Files:**
- Test: `src/session/discovery.test.ts`

- [ ] **Step 1: Write tests for all remaining tools**

Add these test cases inside `describe("discoverStackTools")`:

```typescript
	it("detects Drizzle", () => {
		writeFileSync(join(tmpDir, "drizzle.config.ts"), "export default {}");

		const tools = discoverStackTools(tmpDir);
		expect(tools).toHaveLength(1);
		expect(tools[0]).toMatchObject({
			name: "drizzle",
			category: "orm",
			language: "typescript",
			infraCommand: "npx drizzle-kit push",
		});
	});

	it("detects TypeORM via data-source.ts", () => {
		writeFileSync(join(tmpDir, "data-source.ts"), "export const AppDataSource = {}");

		const tools = discoverStackTools(tmpDir);
		expect(tools).toHaveLength(1);
		expect(tools[0]).toMatchObject({ name: "typeorm", configFile: "data-source.ts" });
	});

	it("detects Sequelize via .sequelizerc", () => {
		writeFileSync(join(tmpDir, ".sequelizerc"), "module.exports = {}");

		const tools = discoverStackTools(tmpDir);
		expect(tools).toHaveLength(1);
		expect(tools[0]).toMatchObject({ name: "sequelize" });
	});

	it("detects Rails", () => {
		writeFileSync(join(tmpDir, "Gemfile"), 'gem "rails"');
		mkdirSync(join(tmpDir, "db", "migrate"), { recursive: true });

		const tools = discoverStackTools(tmpDir);
		expect(tools).toHaveLength(1);
		expect(tools[0]).toMatchObject({
			name: "rails",
			category: "orm",
			language: "ruby",
			infraCommand: "bundle exec rails db:migrate",
		});
	});

	it("detects Django", () => {
		writeFileSync(join(tmpDir, "manage.py"), "#!/usr/bin/env python");
		mkdirSync(join(tmpDir, "myapp", "migrations"), { recursive: true });
		writeFileSync(join(tmpDir, "myapp", "migrations", "__init__.py"), "");

		const tools = discoverStackTools(tmpDir);
		expect(tools).toHaveLength(1);
		expect(tools[0]).toMatchObject({
			name: "django",
			category: "orm",
			language: "python",
		});
	});

	it("detects Alembic", () => {
		writeFileSync(join(tmpDir, "alembic.ini"), "[alembic]");

		const tools = discoverStackTools(tmpDir);
		expect(tools).toHaveLength(1);
		expect(tools[0]).toMatchObject({ name: "alembic", language: "python" });
	});

	it("detects Laravel", () => {
		writeFileSync(join(tmpDir, "artisan"), "#!/usr/bin/env php");
		mkdirSync(join(tmpDir, "database", "migrations"), { recursive: true });

		const tools = discoverStackTools(tmpDir);
		expect(tools).toHaveLength(1);
		expect(tools[0]).toMatchObject({
			name: "laravel",
			category: "orm",
			language: "php",
		});
	});

	it("detects Flyway via flyway.conf", () => {
		writeFileSync(join(tmpDir, "flyway.conf"), "flyway.url=jdbc:...");

		const tools = discoverStackTools(tmpDir);
		expect(tools).toHaveLength(1);
		expect(tools[0]).toMatchObject({ name: "flyway", language: "java" });
	});

	it("detects Liquibase", () => {
		writeFileSync(join(tmpDir, "liquibase.properties"), "url=jdbc:...");

		const tools = discoverStackTools(tmpDir);
		expect(tools).toHaveLength(1);
		expect(tools[0]).toMatchObject({ name: "liquibase", language: "java" });
	});

	it("detects Goose via go.mod", () => {
		writeFileSync(join(tmpDir, "go.mod"), "module example.com\nrequire github.com/pressly/goose v3");

		const tools = discoverStackTools(tmpDir);
		expect(tools).toHaveLength(1);
		expect(tools[0]).toMatchObject({ name: "goose", language: "go" });
	});

	it("detects golang-migrate via go.mod", () => {
		writeFileSync(join(tmpDir, "go.mod"), "module example.com\nrequire github.com/golang-migrate/migrate v4");

		const tools = discoverStackTools(tmpDir);
		expect(tools).toHaveLength(1);
		expect(tools[0]).toMatchObject({ name: "golang-migrate", language: "go" });
	});

	it("detects Orval", () => {
		writeFileSync(join(tmpDir, "orval.config.ts"), "export default {}");

		const tools = discoverStackTools(tmpDir);
		expect(tools).toHaveLength(1);
		expect(tools[0]).toMatchObject({
			name: "orval",
			category: "api-codegen",
			infraCommand: "npx orval",
		});
	});

	it("detects Kubb", () => {
		writeFileSync(join(tmpDir, "kubb.config.ts"), "export default {}");

		const tools = discoverStackTools(tmpDir);
		expect(tools).toHaveLength(1);
		expect(tools[0]).toMatchObject({ name: "kubb", category: "api-codegen" });
	});

	it("detects GraphQL Codegen", () => {
		writeFileSync(join(tmpDir, "codegen.ts"), "export default {}");

		const tools = discoverStackTools(tmpDir);
		expect(tools).toHaveLength(1);
		expect(tools[0]).toMatchObject({ name: "graphql-codegen", category: "api-codegen" });
	});

	it("detects Protobuf via buf.yaml", () => {
		writeFileSync(join(tmpDir, "buf.yaml"), "version: v1");

		const tools = discoverStackTools(tmpDir);
		expect(tools).toHaveLength(1);
		expect(tools[0]).toMatchObject({ name: "protobuf", category: "other" });
	});

	it("detects multiple tools", () => {
		mkdirSync(join(tmpDir, "prisma"), { recursive: true });
		writeFileSync(join(tmpDir, "prisma", "schema.prisma"), "generator client {}");
		writeFileSync(join(tmpDir, "orval.config.ts"), "export default {}");

		const tools = discoverStackTools(tmpDir);
		expect(tools).toHaveLength(2);
		expect(tools.map((t) => t.name)).toEqual(["prisma", "orval"]);
	});

	it("enriches manual hint with existing migration files", () => {
		mkdirSync(join(tmpDir, "prisma", "migrations", "0001_init"), { recursive: true });
		writeFileSync(join(tmpDir, "prisma", "migrations", "0001_init", "migration.sql"), "CREATE TABLE...");
		writeFileSync(join(tmpDir, "prisma", "schema.prisma"), "generator client {}");

		const tools = discoverStackTools(tmpDir);
		expect(tools[0]?.manualHint).toContain("0001_init");
	});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `pnpm vitest run src/session/discovery.test.ts -t "discoverStackTools"`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add src/session/discovery.test.ts
git commit -m "test: add comprehensive discoverStackTools() tests for all 16 tools"
```

## Chunk 2: Infra Status Resolution

### Task 3: resolveInfraStatus()

**Files:**
- Modify: `src/session/lifecycle.ts`
- Test: `src/session/lifecycle.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/session/lifecycle.test.ts`:

```typescript
import { allocatePort, isPortInUse, resolveInfraStatus, runLifecycle, waitForPort } from "./lifecycle.js";

// ... existing tests ...

describe("resolveInfraStatus", () => {
	it("returns unavailable for skip mode", () => {
		expect(resolveInfraStatus("skip", { success: true })).toBe("unavailable");
	});

	it("returns available for auto mode with success", () => {
		expect(resolveInfraStatus("auto", { success: true })).toBe("available");
	});

	it("returns unavailable for auto mode with failure", () => {
		expect(resolveInfraStatus("auto", { success: false })).toBe("unavailable");
	});

	it("returns available for validate-only mode with success", () => {
		expect(resolveInfraStatus("validate-only", { success: true })).toBe("available");
	});

	it("returns unavailable for validate-only mode with failure", () => {
		expect(resolveInfraStatus("validate-only", { success: false })).toBe("unavailable");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/session/lifecycle.test.ts -t "resolveInfraStatus"`
Expected: FAIL

- [ ] **Step 3: Write the implementation**

Add to `src/session/lifecycle.ts`:

```typescript
export type InfraStatus = "available" | "unavailable";

export function resolveInfraStatus(
	mode: LifecycleMode,
	result: { success: boolean },
): InfraStatus {
	if (mode === "skip") return "unavailable";
	return result.success ? "available" : "unavailable";
}
```

Note: Import `LifecycleMode` from types — it's already imported via `LifecycleConfig`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/session/lifecycle.test.ts -t "resolveInfraStatus"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/session/lifecycle.ts src/session/lifecycle.test.ts
git commit -m "feat: add resolveInfraStatus() for infra availability determination"
```

## Chunk 3: Prompt Injection

### Task 4: buildStackInstructions()

**Files:**
- Modify: `src/prompt.ts`
- Create: `src/prompt.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/prompt.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import type { StackTool } from "./session/discovery.js";
import { buildStackInstructions } from "./prompt.js";

describe("buildStackInstructions", () => {
	const prisma: StackTool = {
		name: "prisma",
		category: "orm",
		language: "typescript",
		configFile: "prisma/schema.prisma",
		infraCommand: "npx prisma db push",
		manualHint: "Create migration files manually in `prisma/migrations/`.",
	};

	const orval: StackTool = {
		name: "orval",
		category: "api-codegen",
		language: "typescript",
		configFile: "orval.config.ts",
		infraCommand: "npx orval",
		manualHint: "Create TypeScript types manually based on the OpenAPI spec.",
	};

	it("returns empty string when no tools", () => {
		expect(buildStackInstructions([], "available")).toBe("");
		expect(buildStackInstructions([], "unavailable")).toBe("");
	});

	it("generates infra-available instructions", () => {
		const result = buildStackInstructions([prisma], "available");
		expect(result).toContain("## Resource Generation");
		expect(result).toContain("Infrastructure services are running");
		expect(result).toContain("npx prisma db push");
		expect(result).not.toContain("Do NOT run");
	});

	it("generates infra-unavailable instructions", () => {
		const result = buildStackInstructions([prisma], "unavailable");
		expect(result).toContain("## Resource Generation");
		expect(result).toContain("not running");
		expect(result).toContain("Do NOT run `npx prisma db push`");
		expect(result).toContain("Create migration files manually");
	});

	it("includes multiple tools", () => {
		const result = buildStackInstructions([prisma, orval], "unavailable");
		expect(result).toContain("### Prisma (ORM)");
		expect(result).toContain("### Orval (API Codegen)");
	});

	it("capitalizes tool name in heading", () => {
		const result = buildStackInstructions([prisma], "available");
		expect(result).toContain("### Prisma (ORM)");
	});

	it("labels api-codegen category correctly", () => {
		const result = buildStackInstructions([orval], "available");
		expect(result).toContain("### Orval (API Codegen)");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/prompt.test.ts`
Expected: FAIL

- [ ] **Step 3: Write the implementation**

Add to `src/prompt.ts`:

```typescript
import type { StackTool } from "./session/discovery.js";
import type { InfraStatus } from "./session/lifecycle.js";

// ... existing code ...

const CATEGORY_LABELS: Record<StackTool["category"], string> = {
	orm: "ORM",
	"api-codegen": "API Codegen",
	other: "Tool",
};

function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}

export function buildStackInstructions(tools: StackTool[], status: InfraStatus): string {
	if (tools.length === 0) return "";

	const sections: string[] = [];

	for (const tool of tools) {
		const label = CATEGORY_LABELS[tool.category];
		const heading = `### ${capitalize(tool.name)} (${label})`;

		if (status === "available") {
			const lines = [heading];
			if (tool.infraCommand) {
				lines.push(`- Run \`${tool.infraCommand}\` to apply changes`);
			}
			sections.push(lines.join("\n"));
		} else {
			const lines = [heading];
			if (tool.infraCommand) {
				lines.push(
					`- Do NOT run \`${tool.infraCommand}\` — infrastructure services are not available`,
				);
			}
			lines.push(`- ${tool.manualHint}`);
			sections.push(lines.join("\n"));
		}
	}

	const intro =
		status === "available"
			? "Infrastructure services are running. Use the following commands to generate resources:"
			: "The following tools were detected but infrastructure services are not running.\nCreate resources manually following project conventions:";

	return `\n## Resource Generation\n\n${intro}\n\n${sections.join("\n\n")}\n`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/prompt.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/prompt.ts src/prompt.test.ts
git commit -m "feat: add buildStackInstructions() for contextual prompt injection"
```

## Chunk 4: Session Integration

### Task 5: Update session files to use stack detection and fallback

**Files:**
- Modify: `src/loop/worktree-session.ts:104-253` (native worktree)
- Modify: `src/loop/worktree-session.ts:255-433` (manual worktree)
- Modify: `src/loop/branch-session.ts:18-166`
- Modify: `src/loop/multi-repo-session.ts:178-313`

The pattern is the same for all sessions. Replace the lifecycle abort with fallback + stack instructions.

- [ ] **Step 1: Update imports in worktree-session.ts**

Add to the imports in `src/loop/worktree-session.ts`:

```typescript
import { discoverInfra, discoverStackTools } from "../session/discovery.js";
import { resolveInfraStatus, runLifecycle, stopResources } from "../session/lifecycle.js";
import { buildStackInstructions } from "../prompt.js"; // add buildStackInstructions
```

Note: `discoverStackTools` is a new import. `resolveInfraStatus` is a new import. `buildStackInstructions` needs to be imported from prompt.ts.

- [ ] **Step 2: Update runNativeWorktreeSession lifecycle block**

In `src/loop/worktree-session.ts`, replace lines 120-143 (the lifecycle block in `runNativeWorktreeSession`):

```typescript
	// Detect stack tools and infrastructure
	const stackTools = discoverStackTools(repoPath);
	const infra = discoverInfra(repoPath);
	let lifecycleEnv: Record<string, string> = {};
	let lifecycleSuccess = true;
	if (infra) {
		startSpinner(`${issue.id} — starting resources...`);
		const started = await runLifecycle(infra, config.lifecycle, repoPath);
		stopSpinner();
		lifecycleSuccess = started.success;
		if (!started.success) {
			logger.warn(`Lifecycle startup failed for ${issue.id}. Continuing with manual resource instructions.`);
		}
		lifecycleEnv = started.env;
	}
	const lifecycleMode = config.lifecycle?.mode ?? "skip";
	const infraStatus = resolveInfraStatus(lifecycleMode, { success: lifecycleSuccess });
	const stackBlock = buildStackInstructions(stackTools, infraStatus);
```

- [ ] **Step 3: Inject stackBlock into the prompt call for native worktree**

The `buildNativeWorktreePrompt` function needs to accept the stack block. The simplest approach: append `stackBlock` to the prompt after building it.

In `runNativeWorktreeSession`, after the `const prompt = buildNativeWorktreePrompt(...)` call, add:

```typescript
	const fullPrompt = stackBlock ? `${prompt}\n${stackBlock}` : prompt;
```

Then use `fullPrompt` instead of `prompt` in the `runWithFallback` call.

- [ ] **Step 4: Apply the same pattern to runManualWorktreeSession**

In `src/loop/worktree-session.ts`, `runManualWorktreeSession`:

Replace lines 303-327 (lifecycle block):

```typescript
	// Detect stack tools and infrastructure
	const stackTools = discoverStackTools(worktreePath);
	const infra = discoverInfra(worktreePath);
	let lifecycleEnv: Record<string, string> = {};
	let lifecycleSuccess = true;
	if (infra) {
		startSpinner(`${issue.id} — starting resources...`);
		const started = await runLifecycle(infra, config.lifecycle, worktreePath);
		stopSpinner();
		lifecycleSuccess = started.success;
		if (!started.success) {
			logger.warn(`Lifecycle startup failed for ${issue.id}. Continuing with manual resource instructions.`);
		}
		lifecycleEnv = started.env;
	}
	const lifecycleMode = config.lifecycle?.mode ?? "skip";
	const infraStatus = resolveInfraStatus(lifecycleMode, { success: lifecycleSuccess });
	const stackBlock = buildStackInstructions(stackTools, infraStatus);
```

After `const prompt = buildImplementPrompt(...)`:

```typescript
	const fullPrompt = stackBlock ? `${prompt}\n${stackBlock}` : prompt;
```

Use `fullPrompt` in `runWithFallback`.

- [ ] **Step 5: Apply the same pattern to branch-session.ts**

In `src/loop/branch-session.ts`, add new imports:

```typescript
import { discoverInfra, discoverStackTools } from "../session/discovery.js";
import { resolveInfraStatus, runLifecycle, stopResources } from "../session/lifecycle.js";
import { buildStackInstructions } from "../prompt.js"; // add buildStackInstructions
```

Replace lines 42-65 (lifecycle block):

```typescript
	// Detect stack tools and infrastructure
	const stackTools = discoverStackTools(workspace);
	const infra = discoverInfra(workspace);
	let lifecycleEnv: Record<string, string> = {};
	let lifecycleSuccess = true;
	if (infra) {
		startSpinner(`${issue.id} — starting resources...`);
		const started = await runLifecycle(infra, config.lifecycle, workspace);
		stopSpinner();
		lifecycleSuccess = started.success;
		if (!started.success) {
			logger.warn(`Lifecycle startup failed for ${issue.id}. Continuing with manual resource instructions.`);
		}
		lifecycleEnv = started.env;
	}
	const lifecycleMode = config.lifecycle?.mode ?? "skip";
	const infraStatus = resolveInfraStatus(lifecycleMode, { success: lifecycleSuccess });
	const stackBlock = buildStackInstructions(stackTools, infraStatus);
```

After `const prompt = buildImplementPrompt(...)`:

```typescript
	const fullPrompt = stackBlock ? `${prompt}\n${stackBlock}` : prompt;
```

Use `fullPrompt` in `runWithFallback`.

- [ ] **Step 6: Apply the same pattern to multi-repo-session.ts**

In `src/loop/multi-repo-session.ts`, add new imports:

```typescript
import { discoverInfra, discoverStackTools } from "../session/discovery.js";
import { resolveInfraStatus, runLifecycle, stopResources } from "../session/lifecycle.js";
import { buildStackInstructions } from "../prompt.js"; // add buildStackInstructions
```

In `runMultiRepoStep`, replace lines 221-234 (lifecycle block):

```typescript
	// Detect stack tools and infrastructure
	const stackTools = discoverStackTools(worktreePath);
	const infra = discoverInfra(worktreePath);
	let lifecycleEnv: Record<string, string> = {};
	let lifecycleSuccess = true;
	if (infra) {
		startSpinner(`${issue.id} step ${stepNum} — starting resources...`);
		const started = await runLifecycle(infra, config.lifecycle, worktreePath);
		stopSpinner();
		lifecycleSuccess = started.success;
		if (!started.success) {
			logger.warn(`Lifecycle startup failed for step ${stepNum}. Continuing with manual resource instructions.`);
		}
		lifecycleEnv = started.env;
	}
	const lifecycleMode = config.lifecycle?.mode ?? "skip";
	const infraStatus = resolveInfraStatus(lifecycleMode, { success: lifecycleSuccess });
	const stackBlock = buildStackInstructions(stackTools, infraStatus);
```

After `const prompt = buildScopedImplementPrompt(...)`:

```typescript
	const fullPrompt = stackBlock ? `${prompt}\n${stackBlock}` : prompt;
```

Use `fullPrompt` in `runWithFallback`.

- [ ] **Step 7: Run lint and typecheck**

Run: `pnpm run lint && pnpm run typecheck`
Expected: PASS (no errors)

- [ ] **Step 8: Run all tests**

Run: `pnpm run test`
Expected: ALL PASS

- [ ] **Step 9: Commit**

```bash
git add src/loop/worktree-session.ts src/loop/branch-session.ts src/loop/multi-repo-session.ts
git commit -m "feat: integrate stack-aware prompt injection into all session types"
```

### Task 6: Add LifecycleMode export to types

**Files:**
- Modify: `src/types/index.ts`

The `resolveInfraStatus()` function needs `LifecycleMode` as a parameter type. It's already defined in `types/index.ts` and exported. Verify this import works correctly in lifecycle.ts.

- [ ] **Step 1: Verify LifecycleMode is properly importable**

Check that `src/session/lifecycle.ts` can import `LifecycleMode` from `../types/index.js`. It currently imports `LifecycleConfig` — add `LifecycleMode` to that import.

```typescript
import type { LifecycleConfig, LifecycleMode } from "../types/index.js";
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit if needed**

```bash
git add src/session/lifecycle.ts
git commit -m "refactor: import LifecycleMode type for resolveInfraStatus"
```

## Chunk 5: Final Validation

### Task 7: Build and verify

- [ ] **Step 1: Run full CI pipeline**

Run: `pnpm run ci`
Expected: lint + typecheck + test all pass

- [ ] **Step 2: Build and link**

Run: `pnpm run build && npm link`
Expected: Build succeeds, CLI linked

- [ ] **Step 3: Verify no regressions with existing lifecycle tests**

Run: `pnpm vitest run src/session/lifecycle.test.ts`
Expected: ALL PASS

- [ ] **Step 4: Verify no regressions with existing discovery tests**

Run: `pnpm vitest run src/session/discovery.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit any final fixes**

If any fixes were needed, commit them:

```bash
git add -A
git commit -m "fix: address CI issues in stack-aware prompt injection"
```
