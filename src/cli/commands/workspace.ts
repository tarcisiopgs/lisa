import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { defineCommand } from "citty";
import pc from "picocolors";
import { CliError } from "../error.js";

const SUPPORTED: Record<string, readonly string[]> = {
	darwin: ["arm64", "x64"],
	linux: ["arm64", "x64"],
};

/** Pacote npm com o binário do Workspace para a plataforma, ou `null` se não há suporte. */
export function platformPackage(platform: string, arch: string): string | null {
	return SUPPORTED[platform]?.includes(arch)
		? `@tarcisiopgs/lisa-workspace-${platform}-${arch}`
		: null;
}

interface ResolveOptions {
	platform: string;
	arch: string;
	env: NodeJS.ProcessEnv;
	resolve?: (id: string) => string;
}

/** Caminho do binário `lisa-workspace`; `LISA_WORKSPACE_BIN` vence (desenvolvimento). */
export function resolveWorkspaceBinary(opts: ResolveOptions): string {
	if (opts.env.LISA_WORKSPACE_BIN) return opts.env.LISA_WORKSPACE_BIN;
	if (opts.platform === "win32") {
		throw new CliError(
			"Workspace mode is not supported on Windows. Autonomous mode (`lisa run`) still works.",
		);
	}
	const pkg = platformPackage(opts.platform, opts.arch);
	if (!pkg) {
		throw new CliError(`Workspace mode is not available for ${opts.platform}/${opts.arch}.`);
	}
	const resolve = opts.resolve ?? createRequire(import.meta.url).resolve;
	try {
		return resolve(`${pkg}/bin/lisa-workspace`);
	} catch {
		throw new CliError(
			`Workspace mode needs the ${pkg} package, which was not installed (optional dependencies skipped?). Reinstall Lisa without --omit=optional.`,
		);
	}
}

/** Entrega o terminal ao binário e propaga o código de saída. */
export function runWorkspaceBinary(bin: string): void {
	const result = spawnSync(bin, ["ui"], { stdio: "inherit" });
	if (result.error) {
		throw new CliError(`Could not start the workspace: ${result.error.message}`);
	}
	const code = result.status ?? 1;
	if (code !== 0) {
		throw new CliError("", code);
	}
}

/**
 * Abre o Workspace e sai com o código dele. Trata o `CliError` aqui porque o
 * `runMain` do citty imprimiria a stack e sairia sempre com 1.
 */
export function runWorkspace(): void {
	try {
		const bin = resolveWorkspaceBinary({
			platform: process.platform,
			arch: process.arch,
			env: process.env,
		});
		runWorkspaceBinary(bin);
	} catch (err) {
		if (!(err instanceof CliError)) throw err;
		if (err.message) console.error(pc.red(err.message));
		process.exit(err.exitCode);
	}
}

export const workspace = defineCommand({
	meta: {
		name: "workspace",
		description: "Open Workspace mode: projects, git worktrees and interactive agents",
	},
	run() {
		runWorkspace();
	},
});
