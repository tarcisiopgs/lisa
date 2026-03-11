import { describe, expect, it } from "vitest";
import { buildPtyArgs, spawnWithPty, stripAnsi } from "./pty.js";

describe("stripAnsi", () => {
	it("strips SGR color codes", () => {
		expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
	});

	it("strips bold and multiple SGR params", () => {
		expect(stripAnsi("\x1b[1;31mbold red\x1b[0m")).toBe("bold red");
	});

	it("strips 256-color sequences", () => {
		expect(stripAnsi("\x1b[38;5;196mred256\x1b[0m")).toBe("red256");
	});

	it("strips cursor movement sequences", () => {
		expect(stripAnsi("\x1b[2Ahello\x1b[3B")).toBe("hello");
	});

	it("strips cursor position sequences", () => {
		expect(stripAnsi("\x1b[10;20Htext")).toBe("text");
	});

	it("strips screen clearing sequences", () => {
		expect(stripAnsi("\x1b[2Jcontent")).toBe("content");
	});

	it("strips erase line sequences", () => {
		expect(stripAnsi("\x1b[Ktext")).toBe("text");
	});

	it("strips OSC sequences (terminal title)", () => {
		expect(stripAnsi("\x1b]0;My Title\x07content")).toBe("content");
	});

	it("strips character set selection", () => {
		expect(stripAnsi("\x1b(Btext")).toBe("text");
	});

	it("strips simple escape sequences", () => {
		expect(stripAnsi("\x1bMtext")).toBe("text");
	});

	it("normalizes CRLF to LF", () => {
		expect(stripAnsi("line1\r\nline2\r\n")).toBe("line1\nline2\n");
	});

	it("strips standalone CR", () => {
		expect(stripAnsi("old\rnew")).toBe("oldnew");
	});

	it("passes plain text unchanged", () => {
		expect(stripAnsi("hello world\n")).toBe("hello world\n");
	});

	it("handles empty string", () => {
		expect(stripAnsi("")).toBe("");
	});

	it("strips multiple ANSI sequences in one string", () => {
		expect(stripAnsi("\x1b[1m\x1b[31mbold red\x1b[0m normal")).toBe("bold red normal");
	});

	it("handles sequences with question mark parameter", () => {
		expect(stripAnsi("\x1b[?25lhidden cursor\x1b[?25h")).toBe("hidden cursor");
	});

	it("handles mixed ANSI and CRLF", () => {
		expect(stripAnsi("\x1b[32mgreen\x1b[0m\r\nnext line\r\n")).toBe("green\nnext line\n");
	});
});

describe("buildPtyArgs", () => {
	it("returns macOS script args for darwin", () => {
		const result = buildPtyArgs("echo hello", "darwin");
		expect(result).toEqual({
			file: "script",
			args: ["-qF", "/dev/null", "sh", "-c", "echo hello"],
		});
	});

	it("returns Linux script args for linux", () => {
		const result = buildPtyArgs("echo hello", "linux");
		expect(result).toEqual({
			file: "script",
			args: ["-qef", "-c", "echo hello", "/dev/null"],
		});
	});

	it("returns null for win32", () => {
		expect(buildPtyArgs("echo hello", "win32")).toBeNull();
	});

	it("returns null for freebsd", () => {
		expect(buildPtyArgs("echo hello", "freebsd")).toBeNull();
	});

	it("preserves complex commands with shell substitutions", () => {
		const cmd = `claude -p "$(cat '/tmp/lisa-xxx/prompt.md')"`;
		const result = buildPtyArgs(cmd, "darwin");
		expect(result?.args[result.args.length - 1]).toBe(cmd);
	});

	it("preserves commands with special characters", () => {
		const cmd = `aider --message "$(cat '/tmp/prompt.md')" --yes-always --model gpt-4`;
		const result = buildPtyArgs(cmd, "linux");
		expect(result?.args[2]).toBe(cmd);
	});
});

describe("spawnWithPty", () => {
	it("returns isPty true on macOS or Linux", () => {
		const { proc, isPty } = spawnWithPty("echo test");
		const expectedPty = process.platform === "darwin" || process.platform === "linux";
		expect(isPty).toBe(expectedPty);
		proc.kill();
	});

	it("spawns a process that produces output", async () => {
		const { proc } = spawnWithPty("echo 'hello world'");
		const output = await new Promise<string>((resolve) => {
			const chunks: string[] = [];
			proc.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
			proc.on("close", () => resolve(chunks.join("")));
		});
		expect(stripAnsi(output)).toContain("hello world");
	});

	it("propagates non-zero exit code", async () => {
		const { proc } = spawnWithPty("exit 42");
		const exitCode = await new Promise<number>((resolve) => {
			proc.on("close", (code) => resolve(code ?? -1));
		});
		expect(exitCode).toBe(42);
	});

	it("passes environment variables to child process", async () => {
		const { proc } = spawnWithPty("echo $LISA_TEST_VAR", {
			env: { ...process.env, LISA_TEST_VAR: "pty_test_value" },
		});
		const output = await new Promise<string>((resolve) => {
			const chunks: string[] = [];
			proc.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
			proc.on("close", () => resolve(chunks.join("")));
		});
		expect(stripAnsi(output)).toContain("pty_test_value");
	});

	it("passes cwd to child process", async () => {
		const { proc } = spawnWithPty("pwd", { cwd: "/tmp" });
		const output = await new Promise<string>((resolve) => {
			const chunks: string[] = [];
			proc.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
			proc.on("close", () => resolve(chunks.join("")));
		});
		// macOS resolves /tmp to /private/tmp
		expect(stripAnsi(output)).toContain("tmp");
	});
});
