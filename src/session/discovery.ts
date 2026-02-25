import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import * as logger from "../output/logger.js";
import type { LifecycleConfig, ResourceConfig } from "../types/index.js";

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
			up: "docker compose up -d",
			down: "docker compose down",
			startup_timeout: 30,
		});
	}

	// Deduplicate up/down commands: if multiple services share the same compose file,
	// only the first resource should run up/down; the rest just check their port.
	if (resources.length > 1) {
		for (let i = 1; i < resources.length; i++) {
			const r = resources[i];
			if (r) {
				r.up = "true"; // no-op — first resource already started compose
				r.down = "true"; // no-op — first resource will stop compose
			}
		}
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
 * Returns a LifecycleConfig if any infrastructure was detected, or null otherwise.
 */
export function discoverLifecycle(cwd: string): LifecycleConfig | null {
	discoverEnvFile(cwd);

	const resources = discoverDockerCompose(cwd);
	const setup = discoverSetupCommands(cwd);

	if (resources.length === 0 && setup.length === 0) return null;

	logger.log(
		`Auto-discovered infrastructure: ${resources.length} resource(s), ${setup.length} setup command(s)`,
	);

	return { resources, setup };
}
