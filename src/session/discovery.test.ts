import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	discoverDockerCompose,
	discoverEnvFile,
	discoverInfra,
	discoverSetupCommands,
	discoverStackTools,
} from "./discovery.js";

vi.mock("../output/logger.js", () => ({
	ok: vi.fn(),
	log: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
}));

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "lisa-discovery-test-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("discoverDockerCompose", () => {
	it("returns empty array when no compose file exists", () => {
		expect(discoverDockerCompose(tmpDir)).toEqual([]);
	});

	it("detects docker-compose.yml", () => {
		writeFileSync(
			join(tmpDir, "docker-compose.yml"),
			`
services:
  db:
    image: postgres:15
    ports:
      - "5432:5432"
`,
		);

		const resources = discoverDockerCompose(tmpDir);
		expect(resources).toHaveLength(1);
		expect(resources[0]?.name).toBe("db");
		expect(resources[0]?.check_port).toBe(5432);
		expect(resources[0]?.up).toBe("docker compose up -d db");
		expect(resources[0]?.down).toBe("docker compose stop db");
		expect(resources[0]?.startup_timeout).toBe(30);
	});

	it("detects docker-compose.yaml", () => {
		writeFileSync(
			join(tmpDir, "docker-compose.yaml"),
			`
services:
  redis:
    image: redis:7
    ports:
      - "6379:6379"
`,
		);

		const resources = discoverDockerCompose(tmpDir);
		expect(resources).toHaveLength(1);
		expect(resources[0]?.name).toBe("redis");
		expect(resources[0]?.check_port).toBe(6379);
	});

	it("detects compose.yml", () => {
		writeFileSync(
			join(tmpDir, "compose.yml"),
			`
services:
  app:
    build: .
    ports:
      - "3000:3000"
`,
		);

		const resources = discoverDockerCompose(tmpDir);
		expect(resources).toHaveLength(1);
		expect(resources[0]?.name).toBe("app");
		expect(resources[0]?.check_port).toBe(3000);
	});

	it("detects compose.yaml", () => {
		writeFileSync(
			join(tmpDir, "compose.yaml"),
			`
services:
  api:
    build: .
    ports:
      - "8080:8080"
`,
		);

		const resources = discoverDockerCompose(tmpDir);
		expect(resources).toHaveLength(1);
		expect(resources[0]?.name).toBe("api");
		expect(resources[0]?.check_port).toBe(8080);
	});

	it("prefers docker-compose.yml over compose.yml", () => {
		writeFileSync(
			join(tmpDir, "docker-compose.yml"),
			`
services:
  db:
    image: postgres:15
    ports:
      - "5432:5432"
`,
		);
		writeFileSync(
			join(tmpDir, "compose.yml"),
			`
services:
  redis:
    image: redis:7
    ports:
      - "6379:6379"
`,
		);

		const resources = discoverDockerCompose(tmpDir);
		expect(resources).toHaveLength(1);
		expect(resources[0]?.name).toBe("db");
	});

	it("handles multiple services — each gets service-specific commands", () => {
		writeFileSync(
			join(tmpDir, "docker-compose.yml"),
			`
services:
  db:
    image: postgres:15
    ports:
      - "5432:5432"
  redis:
    image: redis:7
    ports:
      - "6379:6379"
`,
		);

		const resources = discoverDockerCompose(tmpDir);
		expect(resources).toHaveLength(2);
		expect(resources[0]?.name).toBe("db");
		expect(resources[0]?.up).toBe("docker compose up -d db");
		expect(resources[0]?.down).toBe("docker compose stop db");
		expect(resources[1]?.name).toBe("redis");
		expect(resources[1]?.up).toBe("docker compose up -d redis");
		expect(resources[1]?.down).toBe("docker compose stop redis");
	});

	it("skips services without ports", () => {
		writeFileSync(
			join(tmpDir, "docker-compose.yml"),
			`
services:
  worker:
    image: node:20
  db:
    image: postgres:15
    ports:
      - "5432:5432"
`,
		);

		const resources = discoverDockerCompose(tmpDir);
		expect(resources).toHaveLength(1);
		expect(resources[0]?.name).toBe("db");
	});

	it("parses host:container port mapping", () => {
		writeFileSync(
			join(tmpDir, "docker-compose.yml"),
			`
services:
  db:
    image: postgres:15
    ports:
      - "15432:5432"
`,
		);

		const resources = discoverDockerCompose(tmpDir);
		expect(resources[0]?.check_port).toBe(15432);
	});

	it("parses ip:host:container port mapping", () => {
		writeFileSync(
			join(tmpDir, "docker-compose.yml"),
			`
services:
  db:
    image: postgres:15
    ports:
      - "0.0.0.0:5432:5432"
`,
		);

		const resources = discoverDockerCompose(tmpDir);
		expect(resources[0]?.check_port).toBe(5432);
	});

	it("handles port with protocol suffix", () => {
		writeFileSync(
			join(tmpDir, "docker-compose.yml"),
			`
services:
  db:
    image: postgres:15
    ports:
      - "5432:5432/tcp"
`,
		);

		const resources = discoverDockerCompose(tmpDir);
		expect(resources[0]?.check_port).toBe(5432);
	});

	it("handles numeric port values", () => {
		writeFileSync(
			join(tmpDir, "docker-compose.yml"),
			`
services:
  db:
    image: postgres:15
    ports:
      - 5432
`,
		);

		const resources = discoverDockerCompose(tmpDir);
		expect(resources).toHaveLength(1);
		expect(resources[0]?.check_port).toBe(5432);
	});

	it("returns empty for invalid YAML", () => {
		writeFileSync(join(tmpDir, "docker-compose.yml"), "{{invalid yaml}}");

		const resources = discoverDockerCompose(tmpDir);
		expect(resources).toEqual([]);
	});

	it("returns empty for compose file with no services key", () => {
		writeFileSync(join(tmpDir, "docker-compose.yml"), "version: '3'\n");

		const resources = discoverDockerCompose(tmpDir);
		expect(resources).toEqual([]);
	});

	it("returns empty for services with empty ports array", () => {
		writeFileSync(
			join(tmpDir, "docker-compose.yml"),
			`
services:
  db:
    image: postgres:15
    ports: []
`,
		);

		const resources = discoverDockerCompose(tmpDir);
		expect(resources).toEqual([]);
	});
});

describe("discoverSetupCommands", () => {
	it("returns empty array when no ORM files found", () => {
		expect(discoverSetupCommands(tmpDir)).toEqual([]);
	});

	it("detects Prisma schema", () => {
		mkdirSync(join(tmpDir, "prisma"), { recursive: true });
		writeFileSync(join(tmpDir, "prisma", "schema.prisma"), "generator client {}");

		const commands = discoverSetupCommands(tmpDir);
		expect(commands).toEqual(["npx prisma generate", "npx prisma db push"]);
	});

	it("detects Drizzle config", () => {
		writeFileSync(join(tmpDir, "drizzle.config.ts"), "export default {}");

		const commands = discoverSetupCommands(tmpDir);
		expect(commands).toEqual(["npx drizzle-kit push"]);
	});

	it("detects TypeORM ormconfig.ts", () => {
		writeFileSync(join(tmpDir, "ormconfig.ts"), "export default {}");

		const commands = discoverSetupCommands(tmpDir);
		expect(commands).toEqual(["npx typeorm migration:run"]);
	});

	it("detects TypeORM data-source.ts", () => {
		writeFileSync(join(tmpDir, "data-source.ts"), "export const AppDataSource = {}");

		const commands = discoverSetupCommands(tmpDir);
		expect(commands).toEqual(["npx typeorm migration:run"]);
	});

	it("detects Sequelize .sequelizerc", () => {
		writeFileSync(join(tmpDir, ".sequelizerc"), "module.exports = {}");

		const commands = discoverSetupCommands(tmpDir);
		expect(commands).toEqual(["npx sequelize-cli db:migrate"]);
	});

	it("detects Sequelize config/config.json", () => {
		mkdirSync(join(tmpDir, "config"), { recursive: true });
		writeFileSync(join(tmpDir, "config", "config.json"), "{}");

		const commands = discoverSetupCommands(tmpDir);
		expect(commands).toEqual(["npx sequelize-cli db:migrate"]);
	});

	it("detects multiple ORMs", () => {
		mkdirSync(join(tmpDir, "prisma"), { recursive: true });
		writeFileSync(join(tmpDir, "prisma", "schema.prisma"), "generator client {}");
		writeFileSync(join(tmpDir, "drizzle.config.ts"), "export default {}");

		const commands = discoverSetupCommands(tmpDir);
		expect(commands).toEqual(["npx prisma generate", "npx prisma db push", "npx drizzle-kit push"]);
	});
});

describe("discoverEnvFile", () => {
	it("does nothing when no .env.example exists", () => {
		discoverEnvFile(tmpDir);
		expect(existsSync(join(tmpDir, ".env"))).toBe(false);
	});

	it("copies .env.example to .env when .env is missing", () => {
		writeFileSync(join(tmpDir, ".env.example"), "DATABASE_URL=postgres://localhost/db");

		discoverEnvFile(tmpDir);

		expect(existsSync(join(tmpDir, ".env"))).toBe(true);
		expect(readFileSync(join(tmpDir, ".env"), "utf-8")).toBe(
			"DATABASE_URL=postgres://localhost/db",
		);
	});

	it("does not overwrite existing .env", () => {
		writeFileSync(join(tmpDir, ".env.example"), "NEW_VAR=new");
		writeFileSync(join(tmpDir, ".env"), "EXISTING_VAR=existing");

		discoverEnvFile(tmpDir);

		expect(readFileSync(join(tmpDir, ".env"), "utf-8")).toBe("EXISTING_VAR=existing");
	});
});

describe("discoverInfra", () => {
	it("returns null when no infrastructure detected", () => {
		expect(discoverInfra(tmpDir)).toBeNull();
	});

	it("returns infra with docker-compose resources", () => {
		writeFileSync(
			join(tmpDir, "docker-compose.yml"),
			`
services:
  db:
    image: postgres:15
    ports:
      - "5432:5432"
`,
		);

		const infra = discoverInfra(tmpDir);
		expect(infra).not.toBeNull();
		expect(infra?.resources).toHaveLength(1);
		expect(infra?.resources[0]?.name).toBe("db");
		expect(infra?.setup).toEqual([]);
	});

	it("returns infra with setup commands only", () => {
		mkdirSync(join(tmpDir, "prisma"), { recursive: true });
		writeFileSync(join(tmpDir, "prisma", "schema.prisma"), "generator client {}");

		const infra = discoverInfra(tmpDir);
		expect(infra).not.toBeNull();
		expect(infra?.resources).toEqual([]);
		expect(infra?.setup).toEqual(["npx prisma generate", "npx prisma db push"]);
	});

	it("returns infra with both resources and setup", () => {
		writeFileSync(
			join(tmpDir, "docker-compose.yml"),
			`
services:
  db:
    image: postgres:15
    ports:
      - "5432:5432"
`,
		);
		mkdirSync(join(tmpDir, "prisma"), { recursive: true });
		writeFileSync(join(tmpDir, "prisma", "schema.prisma"), "generator client {}");

		const infra = discoverInfra(tmpDir);
		expect(infra).not.toBeNull();
		expect(infra?.resources).toHaveLength(1);
		expect(infra?.setup).toEqual(["npx prisma generate", "npx prisma db push"]);
	});

	it("copies .env.example even when returning null", () => {
		writeFileSync(join(tmpDir, ".env.example"), "SECRET=value");

		const infra = discoverInfra(tmpDir);
		expect(infra).toBeNull();
		// But .env should have been copied
		expect(existsSync(join(tmpDir, ".env"))).toBe(true);
	});
});

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
		writeFileSync(
			join(tmpDir, "go.mod"),
			"module example.com\nrequire github.com/pressly/goose v3",
		);

		const tools = discoverStackTools(tmpDir);
		expect(tools).toHaveLength(1);
		expect(tools[0]).toMatchObject({ name: "goose", language: "go" });
	});

	it("detects golang-migrate via go.mod", () => {
		writeFileSync(
			join(tmpDir, "go.mod"),
			"module example.com\nrequire github.com/golang-migrate/migrate v4",
		);

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
		writeFileSync(
			join(tmpDir, "prisma", "migrations", "0001_init", "migration.sql"),
			"CREATE TABLE...",
		);
		writeFileSync(join(tmpDir, "prisma", "schema.prisma"), "generator client {}");

		const tools = discoverStackTools(tmpDir);
		expect(tools[0]?.manualHint).toContain("0001_init");
	});
});
