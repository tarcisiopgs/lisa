# Lisa

<p align="center">
  <img src="src/assets/lisa.png" width="200" alt="Lisa" />
</p>

While the Ralphs of the world flooded GitHub with mindless agent loops — brute-forcing their way through issues with no context, no workflow awareness, and no regard for the mess they leave behind — Lisa takes a different approach. She reads the issue, understands the workspace, picks the right repo, creates the branch, validates her work, and opens the PR. Then she moves on to the next one. When there's nothing left to do, she stops.

Named after the smartest Simpson, Lisa is an autonomous issue resolver that connects your project tracker (Linear or Trello) to an AI coding agent (Claude Code, Gemini CLI, or OpenCode) and delivers pull requests via GitHub. No MCP servers. No prompt chains. No blind retries. Just structured, end-to-end execution.

## Why Lisa?

Most AI agent loops work like Ralph — they grab an issue, throw it at a model, and hope for the best. If it fails, retry. If there's nothing to do, keep polling. Every cycle burns tokens, every retry burns money, and you get no visibility into what went wrong.

Lisa is deterministic. She follows a structured pipeline with clear stages (fetch, activate, implement, validate, PR, update) and stops when the work is done. This means:

- **Token efficiency** — Each issue gets one focused prompt with full context. No wasted retries, no speculative exploration, no idle polling.
- **Multi-repo awareness** — Lisa detects which repos the agent touched and creates one PR per repo. Monorepos with multiple packages just work.
- **Model fallback** — Configure a chain of models (`claude → gemini → opencode`). Transient errors (429, quota, timeout) trigger the next model; non-transient errors stop the chain.
- **Workflow integration** — Issues move through your board in real time (Backlog → In Progress → In Review). Your team always knows what's being worked on.
- **Self-healing** — Orphan issues (stuck in "In Progress" from interrupted runs) are automatically recovered on startup. Pre-push hook failures trigger the agent to fix and retry.
- **Guardrails** — Past failures are logged and injected into future prompts so the agent avoids repeating mistakes.

## Install

```bash
npm install -g @tarcisiopgs/lisa
```

## Environment Variables

```bash
# Required (at least one)
export GITHUB_TOKEN=""    # or have `gh` CLI authenticated

# Required when source = linear
export LINEAR_API_KEY=""

# Required when source = trello
export TRELLO_API_KEY=""
export TRELLO_TOKEN=""
```

## Quick Start

```bash
# Interactive setup
lisa init

# Run continuously until all labeled issues are done
lisa run

# Single issue
lisa run --once

# Specific issue by identifier or URL
lisa run --issue INT-150

# Process up to N issues
lisa run --limit 5

# Preview without executing
lisa run --dry-run

# Override provider for a single run
lisa run --provider gemini --once
```

## Commands

| Command | Description |
|---------|-------------|
| `lisa run` | Run the agent loop |
| `lisa run --once` | Process a single issue |
| `lisa run --issue ID` | Process a specific issue by identifier or URL |
| `lisa run --limit N` | Process up to N issues |
| `lisa run --dry-run` | Preview without executing |
| `lisa run --provider NAME` | Override AI provider |
| `lisa run --label NAME` | Override label filter |
| `lisa run --json` | Output as JSON lines |
| `lisa run --quiet` | Suppress non-essential output |
| `lisa config` | Interactive config wizard |
| `lisa config --show` | Show current config |
| `lisa config --set key=value` | Set a config value |
| `lisa init` | Create `.lisa/config.yaml` |
| `lisa status` | Show session stats |

## Providers

| Provider | CLI | Auto-approve Flag |
|----------|-----|-------------------|
| Claude Code | `claude` | `--dangerously-skip-permissions` |
| Gemini CLI | `gemini` | `--yolo` |
| OpenCode | `opencode` | implicit in `run` |

At least one provider must be installed and available in your PATH.

All providers use `child_process.spawn` with `sh -c`. Prompts are written to a temp file and passed via `$(cat file)` to avoid argument length limits. Output streams to both stdout and the session log file in real time.

### Fallback Chain

Configure multiple models in the `models` array. Lisa tries them in order — transient errors (429, quota, timeout, network) trigger the next model. Non-transient errors stop the chain immediately.

```yaml
models:
  - claude
  - gemini
```

If `models` is not set, Lisa uses the single `provider` field.

## Workflow Modes

### Branch

The AI agent creates a branch directly in your current checkout, implements the changes, and pushes. Simple setup, works everywhere.

### Worktree

Lisa creates an isolated [git worktree](https://git-scm.com/docs/git-worktree) for each issue under `.worktrees/`. The agent works inside the worktree without touching your main checkout. After the PR is created, the worktree is cleaned up automatically.

In multi-repo workspaces, the agent selects the correct repository, creates the worktree, implements, and writes a `.lisa-manifest.json` with the repo path, branch name, and PR title. Lisa reads the manifest to push and create the PR.

Worktree mode is ideal when you want to keep working in the repo while Lisa resolves issues in the background.

## Configuration

Config lives in `.lisa/config.yaml`. Run `lisa init` to create it interactively.

```yaml
provider: claude
models:
  - claude
  - gemini
source: linear
workflow: worktree

source_config:
  team: Engineering
  project: Web App
  label: ready
  pick_from: Backlog
  in_progress: In Progress
  done: In Review

github: cli          # "cli" (gh) or "token" (GITHUB_TOKEN)
workspace: .
base_branch: main

repos:
  - name: my-api
    path: ./api
    base_branch: main
  - name: my-app
    path: ./app
    base_branch: main

loop:
  cooldown: 10       # seconds between issues
  max_sessions: 0    # 0 = unlimited

logs:
  dir: .lisa/logs
  format: text       # "text" or "json"

# Optional — kill stuck providers
overseer:
  enabled: true
  check_interval: 30     # seconds between git status checks
  stuck_threshold: 300   # seconds without git changes before killing
```

### Source-Specific Fields

| Field | Linear | Trello |
|-------|--------|--------|
| `team` | Team name | Board name |
| `project` | Project name | — |
| `pick_from` | Status to pick issues from | List to pick cards from |
| `label` | Label to filter issues | Label to filter cards |
| `in_progress` | In-progress status | In-progress column |
| `done` | Destination status after PR | Destination column after PR |

### Lifecycle Resources

For repos that need services running during implementation (databases, dev servers):

```yaml
repos:
  - name: my-api
    path: ./api
    base_branch: main
    lifecycle:
      resources:
        - name: postgres
          check_port: 5432
          up: "docker compose up -d postgres"
          down: "docker compose down"
          startup_timeout: 30
      setup:
        - "npx prisma generate"
        - "npx prisma db push"
```

Lisa starts resources before the agent runs, waits for the port to be ready, runs setup commands, then stops everything after the session.

## How It Works

```
┌─────────┐    ┌──────────┐    ┌───────────┐    ┌──────────┐    ┌────┐    ┌────────┐
│  Fetch   │───▶│ Activate │───▶│ Implement │───▶│ Validate │───▶│ PR │───▶│ Update │
└─────────┘    └──────────┘    └───────────┘    └──────────┘    └────┘    └────────┘
```

1. **Fetch** — Pulls the next issue from Linear or Trello matching the configured label, team, and project. Issues are sorted by priority. Blocked issues (with unresolved dependencies) are skipped.
2. **Activate** — Moves the issue to `in_progress` so your team knows it's being worked on.
3. **Implement** — Builds a structured prompt with full issue context and sends it to the AI agent. The agent works in a worktree or branch, implements the change, runs validation, and commits.
4. **Validate** — Runs the project's test suite. If tests fail, the session is aborted and the issue reverts.
5. **PR** — Pushes the branch and creates a pull request referencing the original issue. If pre-push hooks fail, Lisa re-invokes the agent to fix the errors and retries (up to 2 recovery attempts).
6. **Update** — Moves the issue to the `done` status and removes the pickup label in a single atomic operation.
7. **Next** — Picks the next issue. When there are no more matching issues, Lisa stops.

### Recovery Mechanisms

- **Orphan recovery** — On startup, Lisa scans for issues stuck in `in_progress` from previous interrupted runs and reverts them to `pick_from`.
- **Push recovery** — If `git push` fails due to pre-push hooks (linter, typecheck, tests), Lisa re-invokes the agent with the error output and retries the push.
- **Signal handling** — SIGINT/SIGTERM gracefully revert the active issue to its previous status before exiting.
- **Guardrails** — Failed sessions are logged to `.lisa/guardrails.md` and injected into future prompts so the agent avoids repeating the same mistakes.

## License

[MIT](LICENSE)
