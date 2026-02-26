import { type ChildProcess, spawn } from "node:child_process";
import { createConnection } from "node:net";
import { resolve } from "node:path";
import * as logger from "../output/logger.js";
import type { InfraConfig, ResourceConfig } from "./discovery.js";

interface ManagedResource {
	name: string;
	config: ResourceConfig;
	process: ChildProcess | null;
}

const managedResources: ManagedResource[] = [];
let cleanupRegistered = false;

export function isPortInUse(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection({ port }, () => {
			socket.destroy();
			resolve(true);
		});
		socket.on("error", () => {
			socket.destroy();
			resolve(false);
		});
	});
}

export function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		const deadline = Date.now() + timeoutMs;
		const check = () => {
			if (Date.now() > deadline) {
				resolve(false);
				return;
			}
			isPortInUse(port).then((inUse) => {
				if (inUse) {
					resolve(true);
				} else {
					setTimeout(check, 500);
				}
			});
		};
		check();
	});
}

/**
 * Find the first free port in the range [basePort, basePort + range).
 * Returns the allocated port, or null if no free port is found.
 */
export async function allocatePort(basePort: number, range: number): Promise<number | null> {
	for (let offset = 0; offset < range; offset++) {
		const port = basePort + offset;
		const inUse = await isPortInUse(port);
		if (!inUse) {
			return port;
		}
	}
	return null;
}

function spawnResource(
	config: ResourceConfig,
	baseCwd: string,
	allocatedPort: number,
): ChildProcess {
	const cwd = config.cwd ? resolve(baseCwd, config.cwd) : baseCwd;
	const env: NodeJS.ProcessEnv = { ...process.env };
	if (config.port_env_var) {
		env[config.port_env_var] = String(allocatedPort);
	}
	const child = spawn("sh", ["-c", config.up], {
		cwd,
		env,
		stdio: "ignore",
		detached: true,
	});
	child.unref();
	return child;
}

function runSetupCommand(command: string, cwd: string, env: Record<string, string>): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn("sh", ["-c", command], {
			cwd,
			env: { ...process.env, ...env },
			stdio: "inherit",
		});
		child.on("close", (code) => {
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(`Setup command failed with exit code ${code}: ${command}`));
			}
		});
		child.on("error", (err) => {
			reject(new Error(`Setup command error: ${err.message}`));
		});
	});
}

export interface StartResourcesResult {
	success: boolean;
	/** Env vars to inject into the provider and setup commands (e.g. { DATABASE_PORT: "5433" }) */
	env: Record<string, string>;
}

/**
 * Start all resources defined in the InfraConfig, allocating free ports when port_range is set.
 * Returns { success, env } where env contains all allocated port env vars.
 */
export async function startResources(
	infra: InfraConfig,
	baseCwd: string,
): Promise<StartResourcesResult> {
	registerCleanup();

	const allocatedEnv: Record<string, string> = {};

	for (const resource of infra.resources) {
		// Allocate a free port
		let allocatedPort: number;
		if (resource.port_range && resource.port_range > 0) {
			const found = await allocatePort(resource.check_port, resource.port_range);
			if (found === null) {
				logger.error(
					`No free port found for "${resource.name}" in range ${resource.check_port}–${resource.check_port + resource.port_range - 1}`,
				);
				await stopResources();
				return { success: false, env: allocatedEnv };
			}
			allocatedPort = found;
			logger.log(`Allocated port ${allocatedPort} for "${resource.name}"`);
		} else {
			allocatedPort = resource.check_port;
		}

		// Track allocated port env var
		if (resource.port_env_var) {
			allocatedEnv[resource.port_env_var] = String(allocatedPort);
		}

		// Check if already running on the allocated port
		const alreadyRunning = await isPortInUse(allocatedPort);
		if (alreadyRunning) {
			logger.ok(`Resource "${resource.name}" already running on port ${allocatedPort}`);
			continue;
		}

		logger.log(`Starting resource "${resource.name}" on port ${allocatedPort}...`);

		const child = spawnResource(resource, baseCwd, allocatedPort);

		managedResources.push({
			name: resource.name,
			config: resource,
			process: child,
		});

		const timeoutMs = (resource.startup_timeout || 30) * 1000;
		const ready = await waitForPort(allocatedPort, timeoutMs);

		if (!ready) {
			logger.error(
				`Resource "${resource.name}" failed to start within ${resource.startup_timeout}s`,
			);
			await stopResources();
			return { success: false, env: allocatedEnv };
		}

		logger.ok(`Resource "${resource.name}" is ready on port ${allocatedPort}`);
	}

	// Run setup commands with the allocated env vars
	for (const command of infra.setup) {
		logger.log(`Running setup: ${command}`);
		try {
			await runSetupCommand(command, baseCwd, allocatedEnv);
			logger.ok(`Setup complete: ${command}`);
		} catch (err) {
			logger.error(`Setup failed: ${err instanceof Error ? err.message : String(err)}`);
			await stopResources();
			return { success: false, env: allocatedEnv };
		}
	}

	return { success: true, env: allocatedEnv };
}

export async function stopResources(): Promise<void> {
	for (const managed of managedResources) {
		const { name, config, process: child } = managed;

		logger.log(`Stopping resource "${name}"...`);

		try {
			if (config.down === "auto") {
				if (child?.pid) {
					try {
						process.kill(-child.pid, "SIGTERM");
					} catch {
						// Process may already be dead
					}
				}
			} else {
				await new Promise<void>((resolve) => {
					const down = spawn("sh", ["-c", config.down], {
						stdio: "ignore",
					});
					down.on("close", () => resolve());
					down.on("error", () => resolve());
				});
			}
			logger.ok(`Resource "${name}" stopped`);
		} catch (err) {
			logger.warn(
				`Failed to stop resource "${name}": ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	managedResources.length = 0;
}

function registerCleanup(): void {
	if (cleanupRegistered) return;
	cleanupRegistered = true;

	const cleanup = () => {
		for (const managed of managedResources) {
			const { config, process: child } = managed;
			try {
				if (config.down === "auto") {
					if (child?.pid) {
						process.kill(-child.pid, "SIGTERM");
					}
				}
			} catch {
				// Best-effort cleanup
			}
		}
	};

	process.on("exit", cleanup);
	process.on("SIGINT", () => {
		cleanup();
		process.exit(130);
	});
	process.on("SIGTERM", () => {
		cleanup();
		process.exit(143);
	});
}
