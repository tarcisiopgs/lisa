# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Lisa?

A deterministic autonomous issue resolver that connects project trackers (Linear, Trello, Plane, Shortcut, GitLab Issues, GitHub Issues, Jira) to AI coding agents (Claude Code, Gemini CLI, OpenCode, GitHub Copilot CLI, Cursor Agent, Goose, Aider, Codex, Kilo Code, MiMo Code) and delivers pull requests via GitHub, GitLab, or Bitbucket. Structured pipeline: fetch issue → activate → implement → validate → PR → update status.

Lisa has two modes. **Autonomous** (TypeScript, `src/`) is the issue loop above. **Workspace** (Rust, `workspace/`) is a terminal UI where the user maps projects, creates git worktrees from a project's base branch and works interactively with any supported agent. A background daemon owns the agent terminals. `lisa` without arguments in an interactive terminal asks which mode to use.

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

# Workspace mode (Rust crate in workspace/)
cd workspace && cargo test --locked                              # unit + integration tests
cd workspace && cargo clippy --all-targets --locked -- -D warnings
cd workspace && cargo fmt --check
cd workspace && cargo build --release                            # target/release/lisa-workspace
LISA_WORKSPACE_BIN=workspace/target/release/lisa-workspace lisa workspace  # run a local build

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
│   ├── persistence.ts    # Save/load plan to .lisa/plans/{timestamp}.json
│   └── lineage.ts            # Lineage tracking for plan-decomposed issues
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
│   ├── pr-cache.ts       # PR URL caching across multi-repo sessions
│   ├── state.ts              # Session state persistence (.lisa/sessions/)
│   ├── reactions.ts          # Configurable reaction engine for session events
│   ├── review-monitor.ts     # Post-PR review monitoring and feedback loop
│   └── activity.ts           # JSONL-based Claude Code activity detection
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
│   ├── kilo.ts           # Kilo Code: kilo run --auto
│   ├── mimo.ts           # MiMo Code: mimo run --dangerously-skip-permissions
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

workspace/                # Workspace mode (Rust crate `lisa-workspace`, one binary: daemon | ui | hook)
└── src/
    ├── main.rs           # clap subcommands: `daemon`, `ui`, `hook <event>`
    ├── agents/           # Per-agent catalog: interactive command, full-autonomy flag, resume args, models and effort
    ├── router/           # Jev (TypeSafe) routing: questions, pure decision, router.toml, HTTP client
    ├── git/              # Base branch detection, fetch, non-destructive worktree add/remove, removal checks
    ├── registry/         # Projects + worktrees in ~/.lisa/workspace/state.json (atomic writes, daemon-only)
    ├── protocol/         # u32-LE framed postcard messages; frozen control layer (Hello/HelloReply/Shutdown)
    ├── daemon/           # Lifecycle (flock, socket, generation swap), service (registry+sessions+UI stream), notify
    ├── session/          # PTY (portable-pty), daemon-side screen (alacritty_terminal), state tracker, signals, hooks
    └── ui/               # ratatui client: app logic, input encoding, render (insta snapshots)
```

## Key Flows

### Main loop (`loop/`)

Fetches issues from source, runs provider with fallback chain, creates PRs, updates issue status. On startup, recovers orphan issues stuck in `in_progress` from interrupted runs. Two session modes:

- **Worktree** (`runWorktreeSession`): creates isolated `.worktrees/<branch>` per issue, auto-cleanup after PR.
  - Single-repo: Lisa manages the worktree itself. `Provider.supportsNativeWorktree` still exists, but no provider enables it: `ClaudeProvider` sets it to `false` because `--worktree` needs a TTY and hangs in non-interactive mode.
  - Multi-repo (`repos.length > 1`): two-phase — planning agent produces `.lisa-plan.json` with ordered steps, then sequential execution creates one worktree and one PR per repo.
- **Branch** (`runBranchSession`): agent creates a branch in the current checkout. After implementation, reads `.lisa-manifest.json` for the branch name; falls back to `findBranchByIssueId()`.

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

`determineRepoPath()` routes an issue to a repo (by `match` prefix) and `findBranchByIssueId()` finds the branch the agent created, creating one PR per repo.

### Session State (`session/state.ts`)

Tracks session lifecycle in `.lisa/sessions/{issue-id}.json`. States: `spawning → implementing → validating → pr_created → ci_monitoring → review_pending → changes_requested → approved → done`. Records are created at session start and removed on completion/failure.

### Review Monitor (`session/review-monitor.ts`)

When enabled, polls GitHub PR review status after CI passes. On `changes_requested`, extracts inline review comments, builds a recovery prompt, and re-invokes the agent to address feedback. Configurable `max_retries`, `poll_interval`, and `escalate_after` via the reaction engine.

### Reaction Engine (`session/reactions.ts`)

Configurable actions dispatched on session events. Default reactions: CI failures trigger agent re-invocation (3 retries), review changes trigger re-invocation (2 retries, 1h escalation), approval triggers notification. Users can override via `reactions` config.

### Activity Detection (`session/activity.ts`)

Reads Claude Code's JSONL session files (`~/.claude/projects/<encoded-path>/*.jsonl`) to detect agent activity state. Complements the git-status-based overseer — prevents false stuck kills when the agent is actively reading/analyzing code but hasn't produced git changes yet.

### Workspace mode (`workspace/`)

- **Entry:** `lisa workspace` (`src/cli/commands/workspace.ts`) resolves the binary bundled in the package at `bin/workspace/<os>-<arch>/lisa-workspace`. `LISA_WORKSPACE_BIN` wins, for development. It then runs `lisa-workspace ui`.
- **Mode selector:** bare `lisa` shows it only with stdin+stdout TTY, outside CI and without `LISA_MODE` (`src/cli/mode-selector.ts`).
- **Daemon:** the UI connects over a Unix socket in `/tmp/lisa-<uid>/` (macOS) or `$XDG_RUNTIME_DIR/lisa/` (Linux). When none is running, it re-execs the binary as `daemon` with `setsid`. The daemon holds a `flock` for its whole life, and only the lock holder touches the socket. A daemon from a different binary is replaced silently when no agents run; otherwise the UI asks whether to keep it or restart the agents.
- **Protocol:** the control layer (`Hello`, `HelloReply`, `Shutdown`) is frozen forever, and `protocol/tests.rs` pins its bytes. Work messages evolve with `PROTOCOL_VERSION` (currently 5). Only one `ui` client is attached at a time; `hook`/`cli` connections never evict it.
- **Sessions:** agents run through the user's login shell with the UI's environment. The daemon emulates each screen and streams the focused pane as snapshots and row diffs (coalesced to ~25 ms). Scrollback is 2,000 lines per agent. Stopping kills the whole process group.
- **Routing:** the new worktree dialog takes an optional task. With `TYPESAFE_API_KEY` set, the UI asks Jev in a background thread (3 s timeout, no retry) and fills agent, model and effort; the user confirms. `router::decide` is pure. Only catalogs marked `verified` in `agents/catalog.rs` are routed (Claude Code and Codex); a catalog becomes `verified` only after its command line ran on a real install. The task reaches the agent as one argv element, always last (`-- <task>`), never through a shell string. Model and effort are stored per worktree; the task is not.
- **States:** four per agent (working, needs you, done, idle), fed by:
  - Claude Code hooks injected per session with `--settings`, calling `lisa-workspace hook`
  - OSC 777/9 notifications and title classification
  - the bell
  - output silence, only for agents without better signals
- **Notifications:** every transition into "needs you" or "done" sends a system notification, unless the UI reports that the user is looking at that worktree with the window focused.
- **Two steps:** the new worktree dialog always starts with the task alone (optional). `⏎` opens the second step: agent, model, effort and mode, plus the repository when it comes from a group. With `TYPESAFE_API_KEY` set and a task typed, that `⏎` also asks the router, and its verdict shows on the first line of the second step (`Jev suggests claude · haiku · 76% sure`). Enter never waits for the router.
- **Names:** the dialog has no name field. The worktree name comes from a fixed jazz word list walked from a per-project starting point (`naming::word_name`); no randomness, so the same state gives the same name. It is changed afterwards with `e`.
- **Mouse:** the UI captures the mouse, so selecting text in the terminal needs Shift + drag. In the sidebar, a click does what `⏎` does on that row and the wheel moves the selection. In the pane, an agent that turned mouse reporting on gets the event encoded in its own protocol (SGR or legacy) in pane coordinates; otherwise the wheel scrolls the agent's history (`ClientMsg::Scroll`, served from the daemon-side scrollback; `Snapshot.scrolled` says how far back the view is), or becomes arrow keys on an alternate screen. Any input returns the view to the end.
- **Quitting:** `q` leaves the UI and the agents keep running in the daemon; Lisa prints how many on the way out. `Q` stops every running agent and quits, after a confirmation.
- **Renaming:** `e` renames the selected row, edited in place in the sidebar. A project gets an alias (the folder and slug stay), a group a new name (the slug stays), and a worktree a new name and local branch (`git branch -m`); the worktree id and folder never change, so a running agent is untouched. A branch already pushed keeps its old name on the remote, and Lisa says so.
- **Groups:** a group is a name over several projects, used to list and launch, never to run. The registry keeps `groups` and an optional `group` on each project (schema version 2; older files load as they are). A project belongs to at most one group, and ungrouping only clears the link. The repository tag shown next to a grouped agent is computed by the daemon (`registry::repo_tags`: the project name without the group prefix, falling back to the full name on collision) and travels in `ProjectView.tag`.
- **Sidebar:** groups and standalone projects share one alphabetical list. A group lists the agents of all its repositories directly under it; a repository with no agent takes no row. The width is adjustable with `<` and `>` (20 to 48 columns, default 28). UI preferences (default autonomy, sidebar width, last repository used per group) live in `~/.lisa/workspace/prefs.json` and are read and written as a whole.
- **Worktrees:** created with `--no-track` outside the repo (`~/.lisa/workspaces/<project>/<name>`) and never delete on collision. Removal is refused while there are uncommitted changes or commits on no remote, unless forced. A worktree whose folder was deleted outside Lisa shows as missing on the next state update and can always be removed from the list: git is only asked to prune, a git failure does not block it, and the branch is kept.
- **Tests:** `workspace/tests/` spins up real daemons in temp dirs with a fake `SHELL` that execs fake agents, so no test hooks live in production code.

### Lineage Context (`plan/lineage.ts`)

When `lisa plan` creates multiple issues, lineage context is saved to `.lisa/lineage/{planId}.json`. During execution, each issue's prompt is enriched with its position in the plan hierarchy and sibling task descriptions, preventing duplicate work in concurrent mode.

## Provider Execution Pattern

All providers use `child_process.spawn` with `sh -c` — NOT execa (stdout pipe issues in v9). Prompts are written to a temp file and passed via `$(cat 'file')` to avoid argument length limits. Critical settings: `stdin: 'ignore'` (open stdin blocks Claude Code) and unset `CLAUDECODE` env var (allows nested execution).

No provider currently sets `supportsNativeWorktree = true` (see Main loop).

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
- `pr`: optional `{ reviewers?: string[], assignees?: string[] }` — auto-add reviewers/assignees to PRs. Supports `"self"` keyword in assignees (resolved to authenticated user). Applied post-creation via platform API.
- `review_monitor`: optional post-PR review monitoring (`enabled`, `max_retries`, `poll_interval`, `poll_timeout`, `block_on_failure`)
- `reactions`: optional configurable reactions per event (`ci_failed`, `changes_requested`, `approved`, `agent_stuck`, `validation_failed`). Each reaction has `action` (`reinvoke`/`notify`/`skip`), `max_retries`, `escalate_after`.

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

Release process:

1. Bump `version` in both `package.json` and `workspace/Cargo.toml` (they must match).
2. Commit as `chore: bump version to X.Y.Z` and merge.
3. Create the release from `main`'s tip with `gh release create vX.Y.Z --generate-notes`.

`.github/workflows/publish.yml` does the rest. It verifies that the tag matches both manifests, builds `lisa-workspace` for darwin arm64/x64 and linux musl x64/arm64, bundles the four binaries under `bin/workspace/<os>-<arch>/`, and publishes the main package. The publish is idempotent. npm trusts that workflow by file name; do not rename it.

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

Always read and curate .claude/napkin.md at the start of every session. Apply its contents silently.
