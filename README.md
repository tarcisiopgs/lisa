# Lisa

<p align="center">
  <strong>Label an issue. Walk away. Come back to a PR.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@tarcisiopgs/lisa"><img src="https://img.shields.io/npm/v/@tarcisiopgs/lisa.svg" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@tarcisiopgs/lisa"><img src="https://img.shields.io/npm/dm/@tarcisiopgs/lisa.svg" alt="npm downloads" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT" /></a>
  <img src="https://img.shields.io/node/v/%40tarcisiopgs%2Flisa" alt="Node.js version" />
</p>

<p align="center">
  <img src="assets/demo.gif" alt="Lisa demo" />
</p>

Lisa connects your issue tracker to an AI coding agent and delivers pull requests — autonomously. Tag an issue with a label, Lisa picks it up, implements it, opens a PR, and updates your board. No babysitting.

## Quickstart

```bash
npm install -g @tarcisiopgs/lisa
lisa init    # interactive setup wizard
lisa run
```

## How It Works

```
  Fetch issue → Activate → Build context → Implement → Push → Open PR → Update board → Next
```

Lisa picks the highest-priority labeled issue, moves it to "In Progress", sends a structured prompt to the AI agent, and monitors execution. The agent works in an isolated git worktree, implements the change, runs tests, and commits. Lisa pushes, opens a PR, moves the ticket to "In Review", and picks up the next one.

If something fails — pre-push hooks, quota limits, stuck processes — Lisa handles it: retries with error context, falls back to the next model, or kills and moves on.

## Features

- **7 issue trackers** — Linear, GitHub Issues, GitLab Issues, Jira, Trello, Plane, Shortcut
- **8 AI agents** — Claude Code, Gemini CLI, GitHub Copilot CLI, Cursor Agent, Aider, Goose, OpenCode, Codex
- **Concurrent execution** — process multiple issues in parallel, each in its own worktree
- **Multi-repo** — plans across repos, creates one PR per repo in the correct order
- **Model fallback** — chain models; transient errors (429, quota, timeout) auto-switch to the next
- **Real-time TUI** — Kanban board with live provider output, keyboard controls, PR merge detection
- **Self-healing** — orphan recovery on startup, push failure retry, stuck process detection
- **Guardrails** — past failures are injected into future prompts to avoid repeating mistakes
- **Project context** — auto-generates `.lisa/context.md` with your stack, conventions, and constraints

## Providers

| Provider | Key | Provider | Key |
|----------|-----|----------|-----|
| Claude Code | `claude` | Cursor Agent | `cursor` |
| Gemini CLI | `gemini` | Goose | `goose` |
| GitHub Copilot CLI | `copilot` | Aider | `aider` |
| OpenCode | `opencode` | OpenAI Codex | `codex` |

Configure a fallback chain:

```yaml
provider: claude
models:
  - claude-sonnet-4-6   # primary
  - claude-opus-4-6     # fallback
```

## Commands

```bash
lisa run                     # start the agent loop
lisa run --once              # process a single issue
lisa run --once --dry-run    # preview config without executing
lisa run --watch             # poll for new issues after queue empties
lisa run --concurrency 3     # process 3 issues in parallel
lisa run --issue INT-42      # process a specific issue
lisa run --limit 5           # stop after 5 issues
lisa init                    # create .lisa/config.yaml interactively
lisa status                  # show session stats
lisa context refresh         # regenerate project context
lisa feedback --pr URL       # inject PR review feedback into guardrails
```

## Configuration

Config lives in `.lisa/config.yaml`. Run `lisa init` to create it interactively.

```yaml
provider: claude
source: linear
workflow: worktree       # "worktree" (isolated) or "branch" (in-place)

source_config:
  scope: Engineering
  project: Web App
  label: ready
  pick_from: Backlog
  in_progress: In Progress
  done: In Review

platform: cli            # "cli" (gh), "token" (GITHUB_TOKEN), "gitlab", "bitbucket"
base_branch: main
```

<details>
<summary><strong>Environment variables</strong></summary>

```bash
# PR creation (at least one)
GITHUB_TOKEN=""           # or use `gh` CLI
GITLAB_TOKEN=""           # for platform: gitlab
BITBUCKET_TOKEN=""        # for platform: bitbucket
BITBUCKET_USERNAME=""

# Issue tracker (set the one you use)
LINEAR_API_KEY=""
TRELLO_API_KEY="" && TRELLO_TOKEN=""
PLANE_API_TOKEN=""
SHORTCUT_API_TOKEN=""
GITLAB_TOKEN=""
GITHUB_TOKEN=""
JIRA_BASE_URL="" && JIRA_EMAIL="" && JIRA_API_TOKEN=""
```

</details>

<details>
<summary><strong>Source-specific configuration</strong></summary>

| Field | Linear | Trello | Plane | Shortcut | GitLab Issues | GitHub Issues | Jira |
|-------|--------|--------|-------|----------|---------------|---------------|------|
| `scope` | Team name | Board name | Workspace slug | — | Project path | `owner/repo` | Project key |
| `project` | Project name | — | Project ID | — | — | — | — |
| `pick_from` | Status name | List name | State name | Workflow state | — | — | Status name |
| `label` | Label | Label | Label | Label | Label | Label | Label |
| `in_progress` | Status | Column | State | Workflow state | Label | Label | Status |
| `done` | Status | Column | State | Workflow state | Closes issue | Closes issue | Status |

</details>

<details>
<summary><strong>Multi-repo setup</strong></summary>

```yaml
repos:
  - name: my-api
    path: ./api
    base_branch: main
    match: "[API]"        # route issues by title prefix
  - name: my-app
    path: ./app
    base_branch: main
```

Lisa runs a planning phase, then executes steps sequentially — one worktree and one PR per repo.

</details>

<details>
<summary><strong>Advanced options</strong></summary>

```yaml
loop:
  cooldown: 10             # seconds between issues
  session_timeout: 0       # max seconds per provider run (0 = disabled)

overseer:
  enabled: true
  check_interval: 30       # seconds between git status checks
  stuck_threshold: 300     # kill provider after this many seconds without changes

lifecycle:
  mode: auto               # "auto", "skip" (default), "validate-only"
  timeout: 30

validation:
  require_acceptance_criteria: true
```

</details>

## Writing Good Issues

Issue quality = PR quality. Lisa validates issues and skips vague ones (labeling them `needs-spec`).

**Include:** acceptance criteria (`- [ ]` checklists), relevant file paths, technical constraints, stack info.

```markdown
Title: Add rate limiting to /api/users endpoint

Implement rate limiting on `/api/users` to prevent abuse.

Relevant files: src/routes/users.ts, src/middleware/auth.ts

Acceptance criteria:
- [ ] Requests exceeding 100/min per IP return HTTP 429
- [ ] Rate limit headers included in responses
- [ ] Rate limit state stored in Redis (use src/lib/redis.ts)
- [ ] Existing tests still pass
```

## TUI

The real-time Kanban board shows issue progress, streams provider output, and detects PR merges.

| Key | Action | Key | Action |
|-----|--------|-----|--------|
| `←` `→` | Switch columns | `p` | Pause / resume provider |
| `↑` `↓` | Navigate cards | `k` | Kill current issue |
| `↵` | Open detail view | `s` | Skip current issue |
| `Esc` | Back to board | `o` | Open PR in browser |
| `q` | Quit | | |

## License

[MIT](LICENSE)
