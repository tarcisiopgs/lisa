# matuto

O cabra que resolve suas issues — AI agent loop for Linear/Notion.

Picks up issues from Linear (or Notion), sends them to an AI coding agent (Claude Code, Gemini CLI, or OpenCode), and opens PRs automatically.

## Install

```bash
bun install
bun run build
bun link
```

## Quick Start

```bash
# Interactive setup
matuto init

# Run continuously
matuto run

# Single issue
matuto run --once

# Preview without executing
matuto run --dry-run

# Override provider
matuto run --provider gemini --model gemini-2.5-pro --once
```

## Commands

| Command | Description |
|---------|-------------|
| `matuto run` | Run the agent loop |
| `matuto run --once` | Process a single issue |
| `matuto run --limit N` | Process up to N issues |
| `matuto run --dry-run` | Preview without executing |
| `matuto config` | Interactive config wizard |
| `matuto config --show` | Show current config |
| `matuto config --set key=value` | Set a config value |
| `matuto init` | Create `.matuto/config.yaml` |
| `matuto status` | Show session stats |

## Providers

| Provider | CLI | Skip Permissions |
|----------|-----|-----------------|
| Claude Code | `claude` | `--dangerously-skip-permissions` |
| Gemini CLI | `gemini` | `--yolo` |
| OpenCode | `opencode` | implicit in `run` |

## Configuration

Config lives in `.matuto/config.yaml`:

```yaml
provider: claude
model: claude-sonnet-4-6
effort: medium

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
  dir: .matuto/logs
  format: text
```

CLI flags override config values:

```bash
matuto run --provider gemini --effort high --label "urgent"
```

## How It Works

1. **Pick**: Asks the AI provider to query Linear/Notion MCP for the next issue with the configured label
2. **Implement**: Sends the issue to the AI agent with a detailed implementation prompt
3. **PR**: The agent creates a branch, implements, and opens a PR
4. **Update**: The agent moves the issue status and removes the label
5. **Loop**: Waits `cooldown` seconds and picks the next issue
