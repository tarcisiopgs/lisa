# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Lisa?

A deterministic autonomous issue resolver that connects project trackers (Linear/Trello) to AI coding agents (Claude Code, Gemini CLI, OpenCode, GitHub Copilot CLI, Cursor Agent) and delivers pull requests via GitHub. Structured pipeline: fetch issue → activate → implement → validate → PR → update status.

## Language

- All code, comments, documentation, git commits, PR titles, and PR descriptions must be in English.
- Git commits and PR titles use conventional commits format (`feat:`, `fix:`, `refactor:`, `chore:`).
- Issue descriptions may be in any language — read them for context but produce all artifacts in English.

## Commands

```bash
pnpm run build         # tsup → dist/index.js (ESM, Node 20 target)
pnpm run dev           # Run from source via tsx
pnpm run lint          # Biome lint
pnpm run format        # Biome format --write
pnpm run check         # Biome check (lint + format)
pnpm run typecheck     # tsc --noEmit
pnpm run test          # vitest run
pnpm run test:watch    # vitest (watch mode)
pnpm run test:coverage # vitest run --coverage
pnpm run ci            # lint + typecheck + test in parallel (concurrently)
npm link               # Install `lisa` CLI globally
```

Package manager is **pnpm** (v10.29.3). Use `pnpm` for all install/run commands.

After source changes: always `pnpm run build && npm link` to update the global CLI.

Before committing, run: `pnpm run lint && pnpm run typecheck && pnpm run test`

## Code Style

Biome enforces: tabs, double quotes, semicolons, 100-char line width, recommended lint rules. Pre-commit hook runs `biome check --write` on staged `.ts` files via lint-staged.

## Architecture

```
src/
├── index.ts          # Entry point → delegates to cli.ts
├── cli.ts            # citty commands: run, init, config, status + interactive wizard
├── loop.ts           # Main agent loop orchestration + session management
├── types.ts          # All TypeScript interfaces and type aliases
├── config.ts         # YAML config loading/saving with backward compat
├── prompt.ts         # Prompt templates + detectTestRunner() + detectPackageManager()
├── pr-body.ts        # PR body sanitization (strip HTML, normalize bullets)
├── guardrails.ts     # Failed-session log: reads/writes .lisa/guardrails.md
├── overseer.ts       # Stuck-provider detection via periodic git status checks
├── terminal.ts       # Terminal title (OSC), spinner, bell notification
├── github.ts         # PR creation (gh CLI or GitHub API)
├── worktree.ts       # Git worktree management + feature branch detection
├── lifecycle.ts      # Resource lifecycle (port checks, startup/shutdown)
├── logger.ts         # Logging (console + file, supports text/json/quiet)
├── providers/        # AI agent implementations (spawn child processes)
│   ├── index.ts      # Provider factory, runWithFallback(), fallback eligibility
│   ├── claude.ts     # Claude Code: claude -p --dangerously-skip-permissions [--worktree]
│   ├── gemini.ts     # Gemini CLI: gemini --yolo -p
│   ├── opencode.ts   # OpenCode: opencode run
│   ├── copilot.ts    # GitHub Copilot CLI: copilot --allow-all -p
│   ├── cursor.ts     # Cursor Agent: agent -p --output-format text --force
│   └── goose.ts      # Goose (Block): goose run --text
└── sources/          # Issue tracker integrations
    ├── index.ts      # Source factory
    ├── linear.ts     # Linear GraphQL API
    └── trello.ts     # Trello REST API
```

## Key Flows

### Main loop (`loop.ts`)

Fetches issues from source, runs provider with fallback chain, creates PRs, updates issue status. On startup, recovers orphan issues stuck in `in_progress` from interrupted runs. Two session modes:

- **Worktree** (`runWorktreeSession`): creates isolated `.worktrees/<branch>` per issue, auto-cleanup after PR.
  - Single-repo: uses native worktree (Claude Code `--worktree` flag) if the primary provider supports it (`supportsNativeWorktree = true`), otherwise manages the worktree manually.
  - Multi-repo (`repos.length > 1`): two-phase — planning agent produces `.lisa-plan.json` with ordered steps, then sequential execution creates one worktree and one PR per repo. Lifecycle resources are started and stopped per repo step.
- **Branch** (`runBranchSession`): agent creates a branch in the current checkout. After implementation, reads `.lisa-manifest.json` for the branch name; falls back to `detectFeatureBranches()` heuristic.

### Provider model resolution (`loop.ts` `resolveModels`)

As of v1.4.0, `models[]` in config lists **model names within the configured provider** (not provider names). Examples: `["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5"]` for Claude, `["gemini-2.5-pro", "gemini-2.0-flash"]` for Gemini. Each entry becomes a `ModelSpec { provider, model }` and is tried in order. If a model fails with an eligible error (quota, rate limit, timeout, network), the next model in the list is tried.

### Provider fallback (`providers/index.ts`)

`runWithFallback()` iterates `ModelSpec[]`. Transient/infrastructure errors (429, quota, timeout, network, `lisa-overseer` kill) trigger the next model. Non-transient errors stop the chain. All failures are logged to `.lisa/guardrails.md` and injected into subsequent prompts. If every attempt fails due to infrastructure issues, `isCompleteProviderExhaustion()` returns true and the loop stops.

### Agent communication protocol

Agents write two files in the working directory:
- `.lisa-manifest.json` — `{ repoPath?, branch?, prTitle?, prBody? }` — tells Lisa which branch was created and what to use for the PR.
- `.lisa-plan.json` — `{ steps: [{ repoPath, scope, order }] }` — multi-repo execution plan (worktree multi-repo mode only).
- `.pr-title` — legacy fallback for PR title (first line of file).

These files are cleaned up by Lisa after each session.

### Overseer (`overseer.ts`)

When enabled, periodically runs `git status --porcelain` in the provider's working directory. If no changes are detected within `stuck_threshold` seconds, the provider process is killed with SIGTERM and the error is eligible for fallback.

### Push recovery (`loop.ts` `pushWithRecovery`)

If `git push` fails due to pre-push hooks (husky, lint, typecheck), Lisa re-invokes the provider with the error output using `buildPushRecoveryPrompt()` and retries the push. Up to `MAX_PUSH_RETRIES` (2) recovery attempts.

### Multi-repo (`worktree.ts`)

`detectFeatureBranches()` uses 3-pass detection (issue ID in branch name → branch differs from base → git history search) to find all repos touched, creating one PR per repo.

## Provider Execution Pattern

All providers use `child_process.spawn` with `sh -c` — NOT execa (stdout pipe issues in v9). Prompts are written to a temp file and passed via `$(cat 'file')` to avoid argument length limits. Critical settings: `stdin: 'ignore'` (open stdin blocks Claude Code) and unset `CLAUDECODE` env var (allows nested execution).

Only `ClaudeProvider` sets `supportsNativeWorktree = true`, which enables the `--worktree` flag and delegates worktree lifecycle to Claude Code itself.

## Linear GraphQL Type Rules

Linear's schema is strict about `ID` vs `String`:
- **Queries** (`issue`, `team`): use `String!` for `id` parameters
- **Filters** (`workflowStates(filter: ...)`): use `ID!` for comparators like `{ eq: $teamId }`
- **Mutations** (`issueUpdate`): use `String!` for `id` and input fields (`stateId`, `labelIds`)

These are NOT interchangeable — wrong types cause silent validation failures.

## Core Interfaces

The two core abstractions are `Provider` and `Source` (both in `types.ts`).

- `Provider`: `name`, `supportsNativeWorktree?`, `isAvailable(): Promise<boolean>`, `run(prompt, opts): Promise<RunResult>`
- `Source`: `fetchNextIssue()`, `fetchIssueById()`, `updateStatus()`, `removeLabel()`, `attachPullRequest()`, `completeIssue()`

Adding a new provider: implement `Provider`, register in `providers/index.ts` registry. Adding a new source: implement `Source`, register in `sources/index.ts` factory.

## Configuration

YAML config at `.lisa/config.yaml`. `config.ts` handles backward compatibility (old field names `board`→`team`, `list`→`project`), derives `models[]` from `provider` if not set, and merges CLI flag overrides.

Key config fields:
- `provider` + `models[]`: provider name + optional list of model names within that provider (v1.4.0+). First model = primary, rest = fallbacks.
- `workflow`: `"worktree"` or `"branch"`
- `overseer`: optional stuck-provider detection (`enabled`, `check_interval`, `stuck_threshold`)
- `repos[]`: multi-repo config; each repo can have `match` (issue title prefix routing) and `lifecycle` (resources + setup commands)

## Versioning

Follow [Semantic Versioning](https://semver.org/):

- **Major** (`X.0.0`): Breaking changes to CLI flags, config schema, or provider/source interfaces.
- **Minor** (`0.X.0`): New features, new providers/sources, new CLI flags — backward-compatible.
- **Patch** (`0.0.X`): Bug fixes, documentation updates, internal refactors — no behavior change.

Release process: bump `version` in `package.json`, commit as `chore: bump version to X.Y.Z`, tag `vX.Y.Z`, build, publish to npm, create GitHub release.
