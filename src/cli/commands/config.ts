import { defineCommand } from "citty";
import pc from "picocolors";
import { loadConfig, saveConfig } from "../../config.js";
import { log } from "../../output/logger.js";
import { CliError } from "../error.js";
import { runConfigWizard } from "../wizard.js";

/**
 * Coerce a string value to its most likely type.
 * "true"/"false" → boolean, numeric strings → number, otherwise string.
 */
function coerceValue(value: string): string | number | boolean {
	if (value === "true") return true;
	if (value === "false") return false;
	if (/^\d+$/.test(value)) return Number.parseInt(value, 10);
	if (/^\d+\.\d+$/.test(value)) return Number.parseFloat(value);
	return value;
}

/**
 * Sets a value at a nested path in an object (e.g., "loop.cooldown" → obj.loop.cooldown).
 * Creates intermediate objects as needed.
 */
function setNestedValue(
	obj: Record<string, unknown>,
	path: string,
	value: string | number | boolean,
): void {
	const parts = path.split(".");
	let current: Record<string, unknown> = obj;

	for (let i = 0; i < parts.length - 1; i++) {
		const key = parts[i] as string;
		if (current[key] === undefined || current[key] === null) {
			current[key] = {};
		}
		if (typeof current[key] !== "object" || Array.isArray(current[key])) {
			current[key] = {};
		}
		current = current[key] as Record<string, unknown>;
	}

	const lastKey = parts[parts.length - 1] as string;
	current[lastKey] = value;
}

/**
 * Gets a value at a nested path in an object.
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
	const parts = path.split(".");
	let current: unknown = obj;

	for (const part of parts) {
		if (current === undefined || current === null || typeof current !== "object") {
			return undefined;
		}
		current = (current as Record<string, unknown>)[part];
	}

	return current;
}

export const config = defineCommand({
	meta: {
		name: "config",
		description:
			"Show, edit, or reconfigure .lisa/config.yaml\n\n  Examples:\n    lisa config --show                          Print current configuration\n    lisa config --show --json                   Output config as JSON\n    lisa config --set provider=gemini           Change a top-level value\n    lisa config --set loop.cooldown=5           Change a nested value\n    lisa config --set proof_of_work.enabled=true Enable a feature\n    lisa config --get loop.cooldown             Get a specific value\n    lisa config                                 Open interactive wizard",
	},
	args: {
		show: { type: "boolean", description: "Show current config", default: false },
		set: { type: "string", description: "Set a config value (key.path=value)" },
		get: { type: "string", description: "Get a config value by key path" },
		json: { type: "boolean", description: "Output machine-readable JSON", default: false },
	},
	async run({ args }) {
		if (args.show) {
			const cfg = loadConfig();
			if (args.json) {
				console.log(JSON.stringify(cfg, null, 2));
			} else {
				console.log(pc.cyan("\nCurrent configuration:\n"));
				console.log(JSON.stringify(cfg, null, 2));
			}
			return;
		}

		if (args.get) {
			const cfg = loadConfig();
			const value = getNestedValue(cfg as unknown as Record<string, unknown>, args.get);
			if (value === undefined) {
				console.error(pc.red(`Key "${args.get}" not found in config.`));
				throw new CliError(`Key "${args.get}" not found.`);
			}
			if (args.json) {
				console.log(JSON.stringify(value));
			} else {
				console.log(typeof value === "object" ? JSON.stringify(value, null, 2) : String(value));
			}
			return;
		}

		if (args.set) {
			const eqIndex = args.set.indexOf("=");
			if (eqIndex <= 0) {
				console.error(pc.red("Usage: lisa config --set key.path=value"));
				throw new CliError("Invalid --set format. Expected key.path=value.");
			}
			const key = args.set.slice(0, eqIndex);
			const rawValue = args.set.slice(eqIndex + 1);
			const value = coerceValue(rawValue);

			const cfg = loadConfig();
			setNestedValue(cfg as unknown as Record<string, unknown>, key, value);
			saveConfig(cfg);
			log(`Set ${key} = ${String(value)} (${typeof value})`);
			return;
		}

		// Interactive wizard
		await runConfigWizard();
	},
});
