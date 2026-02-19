# Lisa

<p align="center">
  <img src="src/assets/lisa.png" width="200" alt="Lisa" />
</p>

While the Ralphs of the world flooded GitHub with mindless agent loops — brute-forcing their way through issues with no context, no workflow awareness, and no regard for the mess they leave behind — Lisa takes a different approach. She reads the issue, understands the workspace, picks the right repo, creates the branch, validates her work, and opens the PR. Then she moves on to the next one. When there's nothing left to do, she stops.

Named after the smartest Simpson, Lisa is an autonomous issue resolver that connects your project tracker (Linear or Trello) to an AI coding agent (Claude Code, Gemini CLI, or OpenCode) and delivers pull requests via the GitHub API. No MCP servers. No prompt chains. No blind retries. Just structured, end-to-end execution.

## Why Lisa?

Most AI agent loops work like Ralph — they grab an issue, throw it at a model, and hope for the best. If it fails, retry. If there's nothing to do, keep polling. Every cycle burns tokens, every retry burns money, and you get no visibility into what went wrong.

Lisa is deterministic. She follows a structured pipeline with clear stages (fetch, activate, implement, validate, PR, update) and stops when the work is done. This means:

- **Token efficiency** — Each issue gets one focused prompt with full context (description, acceptance criteria, repo conventions). No wasted retries, no speculative exploration, no idle polling burning API calls.
- **Multi-repo awareness** — Lisa detects which repos the agent actually touched and creates a PR for each. No guessing, no hardcoded paths.
- **Workflow integration** — Issues move through your board in real time (Todo, In Progress, In Review). Your team always knows what's being worked on.
- **Predictable cost** — One issue = one agent session = one set of PRs. You can estimate cost per issue instead of hoping the loop eventually converges.

## Install

```bash
npm install -g @tarcisiopgs/lisa
```

## Environment Variables

Lisa calls external APIs directly. Set these in your shell profile (`~/.zshrc` or `~/.bashrc`):

```bash
# Required (always)
export GITHUB_TOKEN=""

# Required when source = linear
export LINEAR_API_KEY=""

# Required when source = trello
export TRELLO_API_KEY=""
export TRELLO_TOKEN=""
```

The CLI will warn you if any required variable is missing.

## Quick Start

```bash
# Interactive setup
lisa init

# Run continuously
lisa run

# Single issue
lisa run --once

# Preview without executing
lisa run --dry-run

# Override provider
lisa run --provider gemini --once
```

## Commands

| Command | Description |
|---------|-------------|
| `lisa run` | Run the agent loop |
| `lisa run --once` | Process a single issue |
| `lisa run --limit N` | Process up to N issues |
| `lisa run --dry-run` | Preview without executing |
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

All providers stream output to stdout and to the session log file in real time. Prompts are written to a temp file and passed via shell expansion (`$(cat file)`) to avoid argument length limits.

## Workflow Modes

Lisa supports two workflow modes, configured during `lisa init`:

### Branch (default)

The AI agent creates a branch directly in your current checkout, implements the changes, and pushes. Simple setup, works everywhere.

### Worktree

Lisa creates an isolated [git worktree](https://git-scm.com/docs/git-worktree) for each issue under `.worktrees/`. The AI agent works inside the worktree without touching your main checkout. After the PR is created, the worktree is cleaned up automatically.

Worktree mode is ideal when you want to keep working in the repo while Lisa resolves issues in the background.

## Configuration

Config lives in `.lisa/config.yaml`:

**Linear:**
```yaml
provider: claude
source: linear
workflow: branch

source_config:
  team: Engineering
  project: Web App
  label: ready
  pick_from: Todo
  in_progress: In Progress
  done: In Review

github: cli
workspace: .
repos:
  - name: app
    path: ./app
    match: "App:"

loop:
  cooldown: 10
  max_sessions: 0

logs:
  dir: .lisa/logs
  format: text
```

**Trello:**
```yaml
provider: claude
source: trello
workflow: branch

source_config:
  board: Product
  pick_from: Backlog
  label: ready
  in_progress: In Progress
  done: Code Review

github: cli
workspace: .

loop:
  cooldown: 10
  max_sessions: 0

logs:
  dir: .lisa/logs
  format: text
```

### Source-specific fields

| Field | Linear | Trello |
|-------|--------|--------|
| `team` / `board` | Team name | Board name |
| `project` | Project name | — |
| `pick_from` | Status to pick issues from (e.g. Todo) | List to pick cards from (e.g. Backlog) |
| `label` | Label to filter issues | Label to filter cards |
| `in_progress` | In-progress status (e.g. In Progress) | In-progress column |
| `done` | Destination status (e.g. In Review) | Destination column (e.g. Code Review) |

CLI flags override config values:

```bash
lisa run --provider gemini --label "urgent"
```

## How It Works

1. **Fetch** — Pulls the next issue from Linear or Trello matching the configured label, team, and project. Issues are sorted by priority.
2. **Activate** — Moves the issue to the `in_progress` status so your team knows it's being worked on.
3. **Implement** — Builds a structured prompt with full issue context and sends it to the AI agent. The agent creates a branch, implements, validates (lint, typecheck, tests), commits, and pushes.
4. **PR** — Detects every repo the agent touched and creates a pull request for each, referencing the original issue. Multi-repo workspaces are handled automatically.
5. **Update** — Moves the issue to the `done` status and removes the pickup label.
6. **Next** — Picks the next issue. When there are no more issues, Lisa stops. No idle polling, no wasted cycles.

## License

[MIT](LICENSE)
