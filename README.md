# lisa

Autonomous issue resolver — picks up issues from Linear or Trello, sends them to an AI coding agent (Claude Code, Gemini CLI, or OpenCode), and opens PRs via the GitHub API. No MCP servers required.

## Install

```bash
npm install -g @tarcisiopgs/lisa
```

## Environment Variables

lisa calls external APIs directly. Set these in your shell profile (`~/.zshrc` or `~/.bashrc`):

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

lisa supports two workflow modes, configured during `lisa init`:

### Branch (default)

The AI agent creates a branch directly in your current checkout, implements the changes, and pushes. Simple setup, works everywhere.

### Worktree

lisa creates an isolated [git worktree](https://git-scm.com/docs/git-worktree) for each issue under `.worktrees/`. The AI agent works inside the worktree without touching your main checkout. After the PR is created, the worktree is cleaned up automatically.

Worktree mode is ideal when you want to keep working in the repo while lisa resolves issues in the background.

## Configuration

Config lives in `.lisa/config.yaml`:

```yaml
provider: claude
source: linear
workflow: branch

source_config:
  team: Internal
  project: Zenixx
  label: ready
  initial_status: Todo
  active_status: In Progress
  done_status: In Review

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

### Source-specific fields

| Field | Linear | Trello |
|-------|--------|--------|
| `team` | Team name | Board name |
| `project` | Project name | List name (source column) |
| `label` | Label to filter issues | Label to filter cards |
| `initial_status` | Source status (e.g. Todo) | Same as `project` |
| `active_status` | In-progress status (e.g. In Progress) | In-progress column |
| `done_status` | Destination status (e.g. In Review) | Destination column (e.g. Code Review) |

CLI flags override config values:

```bash
lisa run --provider gemini --label "urgent"
```

## How It Works

1. **Fetch** — Calls the Linear GraphQL API or Trello REST API to get the next issue matching the configured label, team, and project. Issues are sorted by priority.
2. **Activate** — Moves the issue to the configured `active_status` (e.g. "In Progress") so your team can see it's being worked on.
3. **Implement** — Builds a prompt with the issue context and sends it to the AI coding agent. In branch mode, the agent creates a branch and works in the current checkout. In worktree mode, lisa creates an isolated worktree first.
4. **PR** — Creates a pull request via the GitHub API (CLI or token) referencing the original issue. In multi-repo workspaces, the correct repo is detected automatically.
5. **Update** — Moves the issue to the configured `done_status` and removes the pickup label via the source API.
6. **Loop** — Waits `cooldown` seconds, then picks the next issue. Repeats until no issues remain or the limit is reached.
