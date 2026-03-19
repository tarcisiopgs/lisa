import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { formatError } from "../errors.js";
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
		// Validate service name to prevent shell injection via malicious compose files
		if (!/^[a-zA-Z0-9._-]+$/.test(serviceName)) {
			logger.warn(`Skipping Docker service with unsafe name: ${serviceName}`);
			continue;
		}

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
			logger.warn(`Failed to copy .env.example: ${formatError(err)}`);
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
	if (resources.length === 0) return null;
	logger.log(`Auto-discovered infrastructure: ${resources.length} resource(s)`);
	return { resources, setup: [] };
}
