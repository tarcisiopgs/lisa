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

## Configuration

Config lives in `.lisa/config.yaml`:

```yaml
provider: claude

source: linear
source_config:
  team: Internal
  project: Zenixx
  label: ready
  status: Backlog

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

CLI flags override config values:

```bash
lisa run --provider gemini --label "urgent"
```

## How It Works

1. **Fetch** — Calls the Linear GraphQL API or Trello REST API to get the next issue matching the configured label, team, and project. Issues are sorted by priority.
2. **Implement** — Builds a prompt with the issue title, description, and repo context, then sends it to the AI coding agent. The agent creates a branch, implements the changes, and pushes to origin.
3. **PR** — Creates a pull request via the GitHub API referencing the original issue.
4. **Update** — Moves the issue status to "In Review" and removes the pickup label via the source API.
5. **Loop** — Waits `cooldown` seconds, then picks the next issue. Repeats until no issues remain or the limit is reached.
