import { type ChildProcess, spawn } from "node:child_process";
import { createConnection } from "node:net";
import { resolve } from "node:path";
import * as logger from "./logger.js";
import type { RepoConfig, ResourceConfig } from "./types.js";

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

function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
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

function spawnResource(config: ResourceConfig, baseCwd: string): ChildProcess {
	const cwd = config.cwd ? resolve(baseCwd, config.cwd) : baseCwd;
	const child = spawn("sh", ["-c", config.up], {
		cwd,
		stdio: "ignore",
		detached: true,
	});
	child.unref();
	return child;
}

function runSetupCommand(command: string, cwd: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn("sh", ["-c", command], {
			cwd,
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

export async function startResources(repo: RepoConfig, baseCwd: string): Promise<boolean> {
	const lifecycle = repo.lifecycle;
	if (!lifecycle) return true;

	registerCleanup();

	// Start resources
	for (const resource of lifecycle.resources) {
		const alreadyRunning = await isPortInUse(resource.check_port);

		if (alreadyRunning) {
			logger.ok(`Resource "${resource.name}" already running on port ${resource.check_port}`);
			continue;
		}

		logger.log(`Starting resource "${resource.name}" on port ${resource.check_port}...`);

		const child = spawnResource(resource, baseCwd);

		managedResources.push({
			name: resource.name,
			config: resource,
			process: child,
		});

		const timeoutMs = (resource.startup_timeout || 30) * 1000;
		const ready = await waitForPort(resource.check_port, timeoutMs);

		if (!ready) {
			logger.error(
				`Resource "${resource.name}" failed to start within ${resource.startup_timeout}s`,
			);
			await stopResources();
			return false;
		}

		logger.ok(`Resource "${resource.name}" is ready on port ${resource.check_port}`);
	}

	// Run setup commands
	for (const command of lifecycle.setup) {
		logger.log(`Running setup: ${command}`);
		try {
			await runSetupCommand(command, baseCwd);
			logger.ok(`Setup complete: ${command}`);
		} catch (err) {
			logger.error(`Setup failed: ${err instanceof Error ? err.message : String(err)}`);
			await stopResources();
			return false;
		}
	}

	return true;
}

export async function stopResources(): Promise<void> {
	for (const managed of managedResources) {
		const { name, config, process: child } = managed;

		logger.log(`Stopping resource "${name}"...`);

		try {
			if (config.down === "auto") {
				// Kill the PID that Lisa started
				if (child?.pid) {
					try {
						process.kill(-child.pid, "SIGTERM");
					} catch {
						// Process may already be dead
					}
				}
			} else {
				// Run the down command
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
