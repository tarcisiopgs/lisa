import { copyFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import * as logger from "../output/logger.js";

export interface ResourceConfig {
	name: string;
	check_port: number;
	port_range?: number; // number of ports to try starting from check_port
	port_env_var?: string; // env var name to inject the allocated port (e.g. "DATABASE_PORT")
	up: string;
	down: string;
	startup_timeout: number;
	cwd?: string;
}

export interface InfraConfig {
	resources: ResourceConfig[];
	setup: string[];
}

const DOCKER_COMPOSE_FILES = [
	"docker-compose.yml",
	"docker-compose.yaml",
	"compose.yml",
	"compose.yaml",
];

interface ComposeService {
	ports?: (string | number)[];
	[key: string]: unknown;
}

interface ComposeFile {
	services?: Record<string, ComposeService>;
	[key: string]: unknown;
}

/**
 * Parse a port mapping string (e.g., "5432:5432", "0.0.0.0:3000:3000/tcp", "8080")
 * and return the host port number, or null if unparsable.
 */
function parseHostPort(port: string | number): number | null {
	const raw = String(port).split("/")[0] ?? "";
	const parts = raw.split(":");
	if (parts.length === 1) {
		const n = Number.parseInt(parts[0] ?? "", 10);
		return Number.isNaN(n) ? null : n;
	}
	if (parts.length === 2) {
		const n = Number.parseInt(parts[0] ?? "", 10);
		return Number.isNaN(n) ? null : n;
	}
	if (parts.length === 3) {
		// host:hostPort:containerPort
		const n = Number.parseInt(parts[1] ?? "", 10);
		return Number.isNaN(n) ? null : n;
	}
	return null;
}

/**
 * Detect a docker-compose file in the given directory and return ResourceConfig[]
 * with one entry per service that exposes ports.
 */
export function discoverDockerCompose(cwd: string): ResourceConfig[] {
	let composeFile: string | null = null;
	for (const name of DOCKER_COMPOSE_FILES) {
		const candidate = join(cwd, name);
		if (existsSync(candidate)) {
			composeFile = candidate;
			break;
		}
	}
	if (!composeFile) return [];

	let content: string;
	try {
		content = readFileSync(composeFile, "utf-8");
	} catch {
		return [];
	}

	let parsed: ComposeFile;
	try {
		parsed = parse(content) as ComposeFile;
	} catch {
		logger.warn("Failed to parse docker-compose file. Skipping auto-discovery for Docker.");
		return [];
	}

	if (!parsed?.services) return [];

	const resources: ResourceConfig[] = [];

	for (const [serviceName, service] of Object.entries(parsed.services)) {
		const firstPort = service.ports?.[0];
		if (firstPort === undefined) continue;

		const hostPort = parseHostPort(firstPort);
		if (hostPort === null) continue;

		resources.push({
			name: serviceName,
			check_port: hostPort,
			up: `docker compose up -d ${serviceName}`,
			down: `docker compose stop ${serviceName}`,
			startup_timeout: 30,
		});
	}

	return resources;
}

/**
 * Detect ORM/migration tools and return setup commands to run.
 */
export function discoverSetupCommands(cwd: string): string[] {
	const commands: string[] = [];

	// Prisma
	if (existsSync(join(cwd, "prisma", "schema.prisma"))) {
		commands.push("npx prisma generate", "npx prisma db push");
	}

	// Drizzle
	if (existsSync(join(cwd, "drizzle.config.ts"))) {
		commands.push("npx drizzle-kit push");
	}

	// TypeORM
	if (existsSync(join(cwd, "ormconfig.ts")) || existsSync(join(cwd, "data-source.ts"))) {
		commands.push("npx typeorm migration:run");
	}

	// Sequelize
	if (existsSync(join(cwd, ".sequelizerc")) || existsSync(join(cwd, "config", "config.json"))) {
		commands.push("npx sequelize-cli db:migrate");
	}

	return commands;
}

/**
 * Copy .env.example to .env if the example exists but .env does not.
 */
export function discoverEnvFile(cwd: string): void {
	const envExample = join(cwd, ".env.example");
	const envFile = join(cwd, ".env");

	if (existsSync(envExample) && !existsSync(envFile)) {
		try {
			copyFileSync(envExample, envFile);
			logger.ok("Copied .env.example → .env");
		} catch (err) {
			logger.warn(
				`Failed to copy .env.example: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
}

/**
 * Auto-discover infrastructure requirements for a repository.
 * Returns an InfraConfig if any infrastructure was detected, or null otherwise.
 */
export function discoverInfra(cwd: string): InfraConfig | null {
	discoverEnvFile(cwd);

	const resources = discoverDockerCompose(cwd);
	const setup = discoverSetupCommands(cwd);

	if (resources.length === 0 && setup.length === 0) return null;

	logger.log(
		`Auto-discovered infrastructure: ${resources.length} resource(s), ${setup.length} setup command(s)`,
	);

	return { resources, setup };
}

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
	detect: (cwd: string) => string | null;
	infraCommand?: string;
	manualHint: string;
}

const STACK_TOOL_DEFS: StackToolDef[] = [
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
		manualHint: "Create migration files in `src/migrations/` using TypeORM migration class format.",
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
	{
		name: "django",
		category: "orm",
		language: "python",
		detect: (cwd) => {
			if (!existsSync(join(cwd, "manage.py"))) return null;
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
		detect: (cwd) => (existsSync(join(cwd, "alembic.ini")) ? "alembic.ini" : null),
		infraCommand: "alembic upgrade head",
		manualHint:
			"Create migration files in `alembic/versions/` following the existing pattern with `upgrade()` and `downgrade()` functions.",
	},
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
	{
		name: "orval",
		category: "api-codegen",
		language: "typescript",
		detect: (cwd) => {
			for (const f of [
				"orval.config.ts",
				"orval.config.js",
				"orval.config.mjs",
				".orvalrc",
				".orvalrc.json",
				".orvalrc.js",
				".orvalrc.ts",
			]) {
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
	{
		name: "protobuf",
		category: "other",
		language: "multi",
		detect: (cwd) => {
			if (existsSync(join(cwd, "buf.yaml"))) return "buf.yaml";
			if (existsSync(join(cwd, "buf.gen.yaml"))) return "buf.gen.yaml";
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

function enrichManualHint(def: StackToolDef, cwd: string): string {
	let hint = def.manualHint;

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
		django: [],
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
		return readdirSync(dir)
			.filter((f) => !f.startsWith("."))
			.sort()
			.reverse()
			.slice(0, max)
			.reverse();
	} catch {
		return [];
	}
}
