import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineCommand } from "citty";
import pc from "picocolors";
import { CliError } from "../error.js";

const SUPPORTED: Record<string, readonly string[]> = {
	darwin: ["arm64", "x64"],
	linux: ["arm64", "x64"],
};

/** Diretório do binário do Workspace para a plataforma, ou `null` se não há suporte. */
export function platformDir(platform: string, arch: string): string | null {
	return SUPPORTED[platform]?.includes(arch) ? `${platform}-${arch}` : null;
}

/** Raiz do pacote instalado (`dist/index.js` → `..`). */
function packageRoot(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "..");
}

interface ResolveOptions {
	platform: string;
	arch: string;
	env: NodeJS.ProcessEnv;
	root?: string;
}

/**
 * Caminho do binário `lisa-workspace` que vem dentro do pacote, em
 * `bin/workspace/<os>-<arch>/`. `LISA_WORKSPACE_BIN` vence (desenvolvimento).
 */
export function resolveWorkspaceBinary(opts: ResolveOptions): string {
	if (opts.env.LISA_WORKSPACE_BIN) return opts.env.LISA_WORKSPACE_BIN;
	if (opts.platform === "win32") {
		throw new CliError(
			"Workspace mode is not supported on Windows. Autonomous mode (`lisa run`) still works.",
		);
	}
	const dir = platformDir(opts.platform, opts.arch);
	if (!dir) {
		throw new CliError(`Workspace mode is not available for ${opts.platform}/${opts.arch}.`);
	}
	const bin = join(opts.root ?? packageRoot(), "bin", "workspace", dir, "lisa-workspace");
	if (!existsSync(bin)) {
		throw new CliError(
			`This Lisa installation has no Workspace binary for ${dir} (${bin}). Reinstall Lisa.`,
		);
	}
	// Alguns gerenciadores de pacote perdem o bit de execução ao extrair
	if ((statSync(bin).mode & 0o111) === 0) {
		try {
			chmodSync(bin, 0o755);
		} catch {
			// Sem permissão: o spawn vai falhar com uma mensagem clara
		}
	}
	return bin;
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
