import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function getContextPath(dir: string): string {
	return join(dir, ".lisa", "context.md");
}

export function contextExists(dir: string): boolean {
	return existsSync(getContextPath(dir));
}

export function readContext(dir: string): string | null {
	const path = getContextPath(dir);
	if (!existsSync(path)) return null;
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return null;
	}
}

export function writeContext(dir: string, content: string): void {
	const lisaDir = join(dir, ".lisa");
	mkdirSync(lisaDir, { recursive: true });
	writeFileSync(getContextPath(dir), content, "utf-8");
}
