# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Lisa?

A deterministic autonomous issue resolver that connects project trackers (Linear, Trello, Plane, Shortcut, GitLab Issues, GitHub Issues, Jira) to AI coding agents (Claude Code, Gemini CLI, OpenCode, GitHub Copilot CLI, Cursor Agent, Goose, Aider, Codex) and delivers pull requests via GitHub, GitLab, or Bitbucket. Structured pipeline: fetch issue → activate → implement → validate → PR → update status.

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

# Run a single test file
pnpm vitest run src/config.test.ts

# Run tests matching a name pattern
pnpm vitest run -t "should load config"
```

Package manager is **pnpm** (v10.30.3). Use `pnpm` for all install/run commands.

After source changes: always `pnpm run build && npm link` to update the global CLI.

Before committing, run: `pnpm run lint && pnpm run typecheck && pnpm run test`

## Code Style

Biome enforces: tabs, double quotes, semicolons, 100-char line width, recommended lint rules. Pre-commit hook runs `biome check --write` on staged `.ts` files via lint-staged.

## Architecture

```
src/
├── index.ts              # Entry point → delegates to cli/, catches CliError
├── config.ts             # YAML config loading/saving with Zod validation + backward compat
├── context.ts            # API client detection + agent prompt enrichment
├── errors.ts             # Shared formatError() utility
├── prompt.ts             # Unified buildPrompt(variant, opts) — single prompt builder
├── paths.ts              # Shared path resolution utilities
├── templates.ts          # Init template definitions (source+provider combos)
├── validation.ts         # Issue spec validation (acceptance criteria check)
├── version.ts            # NPM update check with 24h cache
├── types/
│   └── index.ts          # All TypeScript interfaces and type aliases
├── cli/                  # CLI layer (citty commands + interactive wizard)
│   ├── index.ts          # Main CLI definition, top-level command registration
│   ├── error.ts          # CliError class (typed exit codes, replaces process.exit)
│   ├── wizard.ts         # Interactive init/config wizard (clack prompts)
│   ├── detection.ts      # Provider/model auto-detection for init
│   └── commands/         # One file per CLI subcommand
│       ├── run.ts        # `lisa run` — flags, validation, loop entry
│       ├── init.ts       # `lisa init` — template selection + guided setup
│       ├── config.ts     # `lisa config` — show/set/edit config
│       ├── context.ts    # `lisa context refresh` — regenerate project context
│       ├── status.ts     # `lisa status` — session stats (supports --json)
│       ├── plan.ts       # `lisa plan` — AI-powered issue decomposition
│       ├── doctor.ts     # `lisa doctor` — diagnose setup (config, provider, env, git)
│       ├── issue.ts      # `lisa issue get/done` — worktree helper commands
│       └── feedback.ts   # `lisa feedback` — inject PR review into guardrails
├── plan/                 # AI-powered issue planning and decomposition
│   ├── index.ts          # Orchestrator: prompt → AI → parse → wizard → create
│   ├── prompt.ts         # Planning-specific prompt builder (codebase context)
│   ├── parser.ts         # Parse AI JSON response into PlannedIssue[]
│   ├── wizard.ts         # Interactive review wizard (clack + $EDITOR)
│   ├── create.ts         # Batch issue creation in source with dependency linking
│   └── persistence.ts    # Save/load plan to .lisa/plans/{timestamp}.json
├── loop/                 # Main agent loop orchestration
│   ├── index.ts          # Loop entry point, orchestration
│   ├── sequential.ts     # Sequential issue processing
│   ├── concurrent.ts     # Parallel issue processing (slot pool)
│   ├── worktree-session.ts   # Worktree workflow (single-repo)
│   ├── branch-session.ts     # Branch workflow
│   ├── multi-repo-session.ts # Multi-repo two-phase workflow
│   ├── models.ts         # resolveModels() — model spec resolution
│   ├── manifest.ts       # .lisa-manifest.json read/write
│   ├── recovery.ts       # Push recovery (re-invoke agent on hook failure)
│   ├── result.ts         # Session result handling
│   ├── helpers.ts        # Shared loop utilities (buildRunOptions, failureResult, etc.)
│   ├── context-generation.ts  # Project context auto-generation
│   ├── signals.ts        # SIGINT/SIGTERM graceful shutdown
│   ├── state.ts          # Loop state management
│   └── demo.ts           # Dry-run / demo mode
├── git/                  # Git and PR platform utilities
│   ├── github.ts         # GitHub PR creation (gh CLI)
│   ├── bitbucket.ts      # Bitbucket PR creation (API)
│   ├── gitlab.ts         # GitLab MR creation (API)
│   ├── platform.ts       # PR platform factory (dispatches to github/gitlab/bitbucket)
│   ├── worktree.ts       # Git worktree management + feature branch detection
│   ├── dependency.ts     # Issue dependency/blocker tracking across repos
│   ├── pr-body.ts        # PR body sanitization (strip HTML, normalize bullets)
│   └── pr-feedback.ts    # Extract PR review comments for guardrail injection
├── session/              # Session management
│   ├── lifecycle.ts      # Port utilities (isPortInUse, waitForPort)
│   ├── overseer.ts       # Stuck-provider detection via periodic git status checks
│   ├── guardrails.ts     # Failed-session log: reads/writes .lisa/guardrails.md
│   ├── hooks.ts          # Lifecycle hooks (before_run, after_run, etc.)
│   ├── proof-of-work.ts  # Validation commands (lint, typecheck, test)
│   ├── reconciliation.ts # Active run reconciliation
│   ├── discovery.ts      # Docker Compose auto-discovery + infrastructure setup
│   ├── context-manager.ts # Context file lifecycle management
│   ├── kanban-persistence.ts # TUI state persistence across restarts
│   └── pr-cache.ts       # PR URL caching across multi-repo sessions
├── output/               # Logging and terminal output
│   ├── logger.ts         # Logging (stderr + file, supports default/tui/quiet/verbose)
│   ├── line-color.ts     # Provider output line colorization for TUI
│   └── terminal.ts       # Terminal title (OSC), spinner, bell notification
├── ui/                   # TUI (ink/React) components for Kanban board
│   ├── board.tsx         # Top-level board layout (kanban, watching, empty states)
│   ├── kanban.tsx        # Kanban app — input routing, view state, sidebar mode
│   ├── column.tsx        # Kanban column with scroll + dynamic card width
│   ├── card.tsx          # Issue card (status glyph, title wrap, timer)
│   ├── detail.tsx        # Issue detail view (streaming provider output)
│   ├── sidebar.tsx       # Contextual sidebar legend (5 modes: board/detail/watching/watch-prompt/empty)
│   ├── format.ts         # Shared formatElapsed() utility
│   ├── state.ts          # TUI state management + merge polling
│   └── use-terminal-size.ts # Terminal dimensions hook
├── providers/            # AI agent implementations (spawn child processes)
│   ├── index.ts          # Provider factory, runWithFallback(), fallback eligibility
│   ├── run-provider.ts   # Shared runProviderProcess() + cached isCommandAvailable()
│   ├── claude.ts         # Claude Code: claude -p --dangerously-skip-permissions [--worktree]
│   ├── gemini.ts         # Gemini CLI: gemini --yolo -p
│   ├── opencode.ts       # OpenCode: opencode run
│   ├── copilot.ts        # GitHub Copilot CLI: copilot --allow-all -p
│   ├── cursor.ts         # Cursor Agent: agent -p --output-format text --force
│   ├── goose.ts          # Goose (Block): goose run --text
│   ├── aider.ts          # Aider: aider --message ... --yes-always [--model MODEL]
│   ├── codex.ts          # OpenAI Codex: codex --approval-mode full-auto
│   ├── pty.ts            # PTY-based provider execution (alternative to sh -c)
│   ├── output-buffer.ts  # Provider output buffering
│   ├── heap.ts           # Priority heap for model scheduling
│   └── timeout.ts        # Provider timeout management
└── sources/              # Issue tracker integrations
    ├── index.ts           # Source factory
    ├── base.ts            # Shared createApiClient(), normalizeLabels(), REQUEST_TIMEOUT_MS
    ├── linear.ts          # Linear GraphQL API
    ├── trello.ts          # Trello REST API
    ├── plane.ts           # Plane REST API
    ├── shortcut.ts        # Shortcut REST API
    ├── gitlab-issues.ts   # GitLab Issues REST API
    ├── github-issues.ts   # GitHub Issues REST API
    └── jira.ts            # Jira REST API
```

## Key Flows

### Main loop (`loop/`)

Fetches issues from source, runs provider with fallback chain, creates PRs, updates issue status. On startup, recovers orphan issues stuck in `in_progress` from interrupted runs. Two session modes:

- **Worktree** (`runWorktreeSession`): creates isolated `.worktrees/<branch>` per issue, auto-cleanup after PR.
  - Single-repo: uses native worktree (Claude Code `--worktree` flag) if the primary provider supports it (`supportsNativeWorktree = true`), otherwise manages the worktree manually.
  - Multi-repo (`repos.length > 1`): two-phase — planning agent produces `.lisa-plan.json` with ordered steps, then sequential execution creates one worktree and one PR per repo.
- **Branch** (`runBranchSession`): agent creates a branch in the current checkout. After implementation, reads `.lisa-manifest.json` for the branch name; falls back to `detectFeatureBranches()` heuristic.

### Provider model resolution (`loop/models.ts`)

As of v1.4.0, `models[]` in config lists **model names within the configured provider** (not provider names). Examples: `["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5"]` for Claude, `["gemini-2.5-pro", "gemini-2.0-flash"]` for Gemini. Each entry becomes a `ModelSpec { provider, model }` and is tried in order. If a model fails with an eligible error (quota, rate limit, timeout, network), the next model in the list is tried.

### Provider fallback (`providers/index.ts`)

`runWithFallback()` iterates `ModelSpec[]`. Transient/infrastructure errors (429, quota, timeout, network, `lisa-overseer` kill) trigger the next model. Non-transient errors stop the chain. All failures are logged to `.lisa/guardrails.md` and injected into subsequent prompts. If every attempt fails due to infrastructure issues, `isCompleteProviderExhaustion()` returns true and the loop stops.

### Agent communication protocol

Agents write two files in the working directory:
- `.lisa-manifest.json` — `{ repoPath?, branch?, prTitle?, prBody? }` — tells Lisa which branch was created and what to use for the PR.
- `.lisa-plan.json` — `{ steps: [{ repoPath, scope, order }] }` — multi-repo execution plan (worktree multi-repo mode only).
- `.pr-title` — legacy fallback for PR title (first line of file).

These files are cleaned up by Lisa after each session.

### Overseer (`session/overseer.ts`)

When enabled, periodically runs `git status --porcelain` in the provider's working directory. If no changes are detected within `stuck_threshold` seconds, the provider process is killed with SIGTERM and the error is eligible for fallback.

### Push recovery (`loop/recovery.ts`)

If `git push` fails due to pre-push hooks (husky, lint, typecheck), Lisa re-invokes the provider with the error output using `buildPushRecoveryPrompt()` and retries the push. Up to `MAX_PUSH_RETRIES` (2) recovery attempts.

### Multi-repo (`git/worktree.ts`)

`detectFeatureBranches()` uses 3-pass detection (issue ID in branch name → branch differs from base → git history search) to find all repos touched, creating one PR per repo.

## Provider Execution Pattern

All providers use `child_process.spawn` with `sh -c` — NOT execa (stdout pipe issues in v9). Prompts are written to a temp file and passed via `$(cat 'file')` to avoid argument length limits. Critical settings: `stdin: 'ignore'` (open stdin blocks Claude Code) and unset `CLAUDECODE` env var (allows nested execution).

Only `ClaudeProvider` sets `supportsNativeWorktree = true`, which enables the `--worktree` flag and delegates worktree management to Claude Code itself.

## Linear GraphQL Type Rules

Linear's schema is strict about `ID` vs `String`:
- **Queries** (`issue`, `team`): use `String!` for `id` parameters
- **Filters** (`workflowStates(filter: ...)`): use `ID!` for comparators like `{ eq: $teamId }`
- **Mutations** (`issueUpdate`): use `String!` for `id` and input fields (`stateId`, `labelIds`)

These are NOT interchangeable — wrong types cause silent validation failures.

## Core Interfaces

The two core abstractions are `Provider` and `Source` (both in `types/index.ts`).

- `Provider`: `name`, `supportsNativeWorktree?`, `isAvailable(): Promise<boolean>`, `run(prompt, opts): Promise<RunResult>`
- `Source`: `fetchNextIssue()`, `fetchIssueById()`, `updateStatus()`, `removeLabel()`, `attachPullRequest()`, `completeIssue()`, plus optional wizard helpers: `listScopes()`, `listProjects()`, `listLabels()`, `listStatuses()`

Adding a new provider: implement `Provider`, register in `providers/index.ts` registry. Adding a new source: implement `Source`, register in `sources/index.ts` factory.

### Shared infrastructure

- **`sources/base.ts`**: `createApiClient(baseUrl, getHeaders, name)` — typed HTTP client used by all REST sources (Jira, Plane, Shortcut, GitHub Issues, GitLab Issues). Also exports `normalizeLabels()` and `REQUEST_TIMEOUT_MS`.
- **`providers/run-provider.ts`**: `runProviderProcess()` — shared spawn logic for all providers. `isCommandAvailable(cmd)` — async cached check (avoids repeated `which` calls).
- **`errors.ts`**: `formatError(err)` — universal `Error | unknown → string`.
- **`cli/error.ts`**: `CliError` — typed error with `exitCode`, caught by `index.ts` instead of `process.exit(1)`.

### Prompt unification (`prompt.ts`)

Four separate prompt builders were consolidated into `buildPrompt(variant, opts)` with `PromptVariant` type (`"worktree"`, `"branch"`, `"native-worktree"`, `"multi-repo-plan"`).

### Config validation (`config.ts`)

Zod schemas validate provider, source, platform, workflow, and models[] at load time. `ConfigValidationError` is thrown with actionable messages. `enumOrEmpty()` helper allows empty strings for partially configured files.

### TUI keyboard scoping (`ui/kanban.tsx`)

The sidebar legend is the source of truth for available shortcuts. The kanban input handler gates all actions behind an `activeView` / state check (`board`, `detail`, `watching`, `watch-prompt`, `empty`). Shortcuts not shown in the legend are inactive.

## Configuration

YAML config at `.lisa/config.yaml`. `config.ts` handles backward compatibility (old field names `board`→`scope`, `team`→`scope`, `list`→`project`), derives `models[]` from `provider` if not set, and merges CLI flag overrides. Config is validated at load time via Zod schemas — invalid values produce actionable `ConfigValidationError` messages.

Key config fields:
- `provider` + `models[]`: provider name + optional list of model names within that provider (v1.4.0+). First model = primary, rest = fallbacks.
- `workflow`: `"worktree"` or `"branch"`
- `platform`: `PRPlatform` — PR delivery method; accepts `"cli"` (GitHub CLI), `"token"` (GitHub API token), `"gitlab"`, or `"bitbucket"`.
- `overseer`: optional stuck-provider detection (`enabled`, `check_interval`, `stuck_threshold`)
- `repos[]`: multi-repo config; each repo can have `match` (issue title prefix routing)
- `hooks`: lifecycle hooks (`before_run`, `after_run`, `after_create`, `before_remove`)
- `proof_of_work`: validation commands run after provider completes (lint, typecheck, test)
- `reconciliation`: detect and clean up stale active runs

### CLI flags

Global flags parsed from `process.argv` before citty: `--verbose` / `-v`, `--quiet` / `-q`, `--json`. The `--json` flag outputs machine-readable JSON to stdout. Unknown flags on `lisa run` are rejected with an error.

## Output conventions

- All human-readable output goes to **stderr** (`console.error`). Only machine-readable data (JSON, issue payloads) goes to **stdout** (`console.log`). This allows `lisa run 2>/dev/null | jq` piping.
- `logger.ts` supports 3 modes: `default` (stderr), `tui` (file only, suppresses console), `quiet` (file only).
- `logger.ts` supports 3 log levels: `default`, `quiet` (suppress non-error console), `verbose` (extra debug output).
- `CliError` replaces `process.exit(1)` — thrown from commands and caught in `index.ts` for clean exit with typed exit codes.

## Versioning

Follow [Semantic Versioning](https://semver.org/):

- **Major** (`X.0.0`): Breaking changes to CLI flags, config schema, or provider/source interfaces.
- **Minor** (`0.X.0`): New features, new providers/sources, new CLI flags — backward-compatible.
- **Patch** (`0.0.X`): Bug fixes, documentation updates, internal refactors — no behavior change.

Release process: bump `version` in `package.json`, commit as `chore: bump version to X.Y.Z`, tag `vX.Y.Z`, build, publish to npm, create GitHub release.

<!-- gitnexus:start -->
# GitNexus MCP

This project is indexed by GitNexus as **cli** (767 symbols, 2026 relationships, 59 execution flows).

## Always Start Here

1. **Read `gitnexus://repo/{name}/context`** — codebase overview + check index freshness
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
