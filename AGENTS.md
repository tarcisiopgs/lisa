# AGENTS.md

This file is the primary Codex guide for the Lisa CLI repository. Keep it aligned with
`CLAUDE.md` when repository rules change.

## Product Context

Lisa is a deterministic autonomous issue resolver. It connects issue trackers
(Linear, Trello, Plane, Shortcut, GitLab Issues, GitHub Issues, Jira) to AI coding
agents (Claude Code, Gemini CLI, OpenCode, GitHub Copilot CLI, Cursor Agent, Goose,
Aider, Codex, Kilo Code), then opens pull requests through GitHub, GitLab, or
Bitbucket.

The core pipeline is:

1. Fetch issue.
2. Activate issue.
3. Run an implementation agent.
4. Validate acceptance criteria and configured proof-of-work commands.
5. Push and open a PR/MR.
6. Update issue status and continue the loop.

## Language and Git Rules

- Write all code, comments, documentation, commit messages, PR titles, and PR bodies in English.
- User issue descriptions can be in any language, but produced artifacts stay in English.
- Use conventional commit subjects such as `feat:`, `fix:`, `refactor:`, and `chore:`.
- Do not implement directly on `main`; create a feature branch before source changes unless the user explicitly directs otherwise.
- Do not revert or overwrite user changes. Inspect `git status --short` before edits and work around unrelated dirty files.
- Keep `CLAUDE.md` and this file conceptually aligned when changing repo-level agent guidance.

## Toolchain

- Package manager: `pnpm` only.
- Runtime/build target: Node 20, ESM.
- Main source language: TypeScript with strict checking.
- Formatter/linter: Biome. Settings are tabs, double quotes, semicolons, and 100-character line width.
- Test runner: Vitest.

Common commands:

```bash
pnpm run dev
pnpm run build
pnpm run lint
pnpm run format
pnpm run check
pnpm run typecheck
pnpm run test
pnpm run test:watch
pnpm run test:coverage
pnpm run ci
```

Run a targeted test file with:

```bash
pnpm vitest run src/config.test.ts
```

Run tests matching a name with:

```bash
pnpm vitest run -t "should load config"
```

After TypeScript source changes, run:

```bash
pnpm run build && npm link
```

Before committing, run:

```bash
pnpm run lint && pnpm run typecheck && pnpm run test
```

If the change is narrow and time is limited, run the most relevant targeted tests first, then state clearly which full checks were not run.

## Repository Map

- `src/index.ts`: entry point; delegates to the CLI layer and catches `CliError`.
- `src/config.ts`: YAML config loading/saving, Zod validation, and backward compatibility.
- `src/context.ts`: API client detection and agent prompt enrichment.
- `src/errors.ts`: shared `formatError()` helper.
- `src/templates.ts`: init template definitions.
- `src/validation.ts`: issue spec validation.
- `src/version.ts`: npm update check with 24-hour cache.
- `src/types/`: shared interfaces and type aliases.
- `src/cli/`: citty commands and interactive wizard.
- `src/plan/`: AI planning, issue decomposition, parsing, persistence, and lineage.
- `src/loop/`: main orchestration, sequential/concurrent sessions, recovery, state, and signals.
- `src/git/`: Git worktree helpers and PR/MR platform implementations.
- `src/session/`: lifecycle hooks, proof-of-work, overseer, CI/review monitoring, context management, and persistence.
- `src/output/`: logging, line colorization, terminal title/spinner/bell helpers.
- `src/ui/`: Ink/React terminal Kanban UI.
- `src/providers/`: AI agent process implementations and fallback logic.
- `src/sources/`: issue tracker integrations.

## Architecture Rules

- `Provider` and `Source` are the core interfaces in `src/types/index.ts`.
- Add a provider by implementing `Provider` and registering it in `src/providers/index.ts`.
- Add a source by implementing `Source` and registering it in `src/sources/index.ts`.
- Reuse shared infrastructure before adding one-off logic:
  - REST sources should use `createApiClient()` from `src/sources/base.ts`.
  - Provider child processes should use `runProviderProcess()` from `src/providers/run-provider.ts`.
  - Unknown errors should pass through `formatError()` from `src/errors.ts`.
  - CLI failures should throw `CliError` instead of calling `process.exit()`.
- Human-readable CLI output goes to stderr. Machine-readable output, especially JSON, goes to stdout.
- Keep prompt changes centralized in `src/prompt/` and its shared helpers where possible.
- The TUI sidebar legend is the source of truth for active keyboard shortcuts; gate shortcuts by active view/state.

## Provider and Agent Guardrails

- Providers use `child_process.spawn` with `sh -c`; do not refactor them to `execa`.
- Provider prompts are written to temp files and passed via `$(cat 'file')` to avoid argument length limits.
- Keep provider `stdin` ignored where required; open stdin can block Claude Code.
- Preserve the `CLAUDECODE` environment handling that allows nested execution.
- `models[]` values are model names within the configured provider, not provider names.
- Fallback should continue only for transient/infrastructure failures such as quota, rate limit, timeout, network, and overseer kills.
- Agents communicate results through `.lisa-manifest.json`, `.lisa-plan.json`, and legacy `.pr-title`; keep these contracts stable.

## Domain-Specific Guardrails

- Linear GraphQL is strict about `ID` versus `String`:
  - Queries such as `issue` and `team` use `String!` for `id`.
  - Filters such as `workflowStates(filter: ...)` use `ID!` for comparators.
  - Mutations such as `issueUpdate` use `String!` for `id` and input fields.
- Config validation belongs in `src/config.ts` with Zod schemas and actionable `ConfigValidationError` messages.
- Preserve backward compatibility for documented config aliases unless a breaking change is explicitly requested.
- Worktree mode creates isolated `.worktrees/<branch>` checkouts and cleans them after PR creation.
- Multi-repo mode is two-phase: first produce `.lisa-plan.json`, then execute sequential per-repo worktree/PR steps.
- Guardrail failures are recorded in `.lisa/guardrails.md` and injected into later prompts.

## Validation Expectations

- For CLI, config, prompt, source, provider, loop, session, or git changes, add or update colocated `*.test.ts` tests.
- For TUI changes under `src/ui/`, verify behavior with relevant component tests or focused manual terminal checks when tests are not available.
- For public behavior changes, update README or docs when they are part of the tracked change request.
- For release work, follow semver and use `gh release create vX.Y.Z --generate-notes --notes-start-tag <prev-tag>`.

## Local Context Notes

- `CLAUDE.md` contains a longer Claude Code oriented guide. Use it as background, but make Codex-facing instructions in this file direct and self-contained.
- `.claude/napkin.md` is per-user local memory and may be ignored by Git. If present, skim it for recent high-priority runbook notes, then continue with this file as the stable repository guide.
- The GitNexus block below is generated. Use GitNexus MCP resources when they are available; if they are unavailable, inspect the local source with `rg`, `git`, and targeted file reads instead of blocking.

<!-- gitnexus:start -->
# GitNexus MCP

This project is indexed by GitNexus as **cli** (767 symbols, 2026 relationships, 59 execution flows).

## Always Start Here

1. **Read `gitnexus://repo/{name}/context`** -- codebase overview + check index freshness
2. **Match your task to a skill below** and **read that skill file**
3. **Follow the skill's workflow and checklist**

> If step 1 warns the index is stale, run `npx gitnexus analyze` in the terminal first.

## Skills

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
