# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Lisa?

A deterministic autonomous issue resolver that connects project trackers (Linear/Trello) to AI coding agents (Claude Code, Gemini CLI, OpenCode) and delivers pull requests via GitHub. Structured pipeline: fetch issue → activate → implement → validate → PR → update status.

## Language

- All code, comments, documentation, git commits, PR titles, and PR descriptions must be in English.
- Git commits and PR titles use conventional commits format (`feat:`, `fix:`, `refactor:`, `chore:`).
- Issue descriptions may be in any language — read them for context but produce all artifacts in English.

## Commands

```bash
npm run build          # tsup → dist/index.js (ESM, Node 20 target)
npm run dev            # Run from source via tsx
npm run lint           # Biome lint
npm run format         # Biome format --write
npm run check          # Biome check (lint + format)
npm run typecheck      # tsc --noEmit
npm run test           # vitest run
npm run test:watch     # vitest (watch mode)
npm run ci             # lint + typecheck + test in parallel
npm link               # Install `lisa` CLI globally
```

After source changes: always `npm run build && npm link` to update the global CLI.

Before committing, run: `npm run lint && npm run typecheck && npm run test`

## Code Style

Biome enforces: tabs, double quotes, semicolons, 100-char line width, recommended lint rules. Pre-commit hook runs `biome check --write` on staged `.ts` files via lint-staged.

## Architecture

```
src/
├── index.ts          # Entry point → delegates to cli.ts
├── cli.ts            # citty commands: run, init, config, status
├── loop.ts           # Main agent loop orchestration + session management
├── types.ts          # All TypeScript interfaces and type aliases
├── config.ts         # YAML config loading/saving with backward compat
├── prompt.ts         # Prompt templates (worktree vs branch mode)
├── providers/        # AI agent implementations (spawn child processes)
│   ├── index.ts      # Provider factory, runWithFallback(), fallback eligibility
│   ├── claude.ts     # Claude Code: claude -p --dangerously-skip-permissions
│   ├── gemini.ts     # Gemini CLI: gemini --yolo -p
│   └── opencode.ts   # OpenCode: opencode run
├── sources/          # Issue tracker integrations
│   ├── index.ts      # Source factory
│   ├── linear.ts     # Linear GraphQL API
│   └── trello.ts     # Trello REST API
├── github.ts         # PR creation (gh CLI or GitHub API)
├── worktree.ts       # Git worktree management + feature branch detection
├── lifecycle.ts      # Resource lifecycle (port checks, startup/shutdown)
├── notify.ts         # Native OS notifications (macOS/Linux)
└── logger.ts         # Logging (console + file, supports text/json/quiet)
```

### Key Flows

**Main loop** (`loop.ts`): Fetches issues from source, runs provider with fallback chain, creates PRs, updates issue status. Two session modes: **Worktree** (isolated `.worktrees/` per issue, auto-cleanup) and **Branch** (agent creates branch in current checkout, multi-repo detection).

**Provider fallback** (`providers/index.ts`): Tries models in `config.models[]` order. Transient errors (429, quota, timeout, network) trigger next provider; non-transient errors stop the chain.

**Multi-repo** (`worktree.ts`): `detectFeatureBranches()` uses 3-pass detection (issue ID in branch name → branch differs from base → git history search) to find all repos touched, creating one PR per repo.

### Provider Execution Pattern

All providers use `child_process.spawn` with `sh -c` — NOT execa (stdout pipe issues in v9). Prompts are written to a temp file and passed via `$(cat 'file')` to avoid argument length limits. Critical settings: `stdin: 'ignore'` (open stdin blocks Claude Code) and unset `CLAUDECODE` env var (allows nested execution).

### Linear GraphQL Type Rules

Linear's schema is strict about `ID` vs `String`:
- **Queries** (`issue`, `team`): use `String!` for `id` parameters
- **Filters** (`workflowStates(filter: ...)`): use `ID!` for comparators like `{ eq: $teamId }`
- **Mutations** (`issueUpdate`): use `String!` for `id` and input fields (`stateId`, `labelIds`)

These are NOT interchangeable — wrong types cause silent validation failures.

### Core Interfaces

The two core abstractions are `Provider` and `Source` (both in `types.ts`). Providers implement `isAvailable()` and `run(prompt, opts) → RunResult`. Sources implement `fetchNextIssue()`, `fetchIssueById()`, `updateStatus()`, `removeLabel()`, and `attachPullRequest()`. Adding a new provider or source means implementing one of these interfaces and registering it in the respective `index.ts` factory.

### Configuration

YAML config at `.lisa/config.yaml`. `config.ts` handles backward compatibility (old field names `board`→`team`, `list`→`project`), derives `models[]` from `provider` if not set, and merges CLI flag overrides.
