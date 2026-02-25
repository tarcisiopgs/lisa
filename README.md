# Lisa

<p align="center">
  <img src="assets/lisa.png" width="200" alt="Lisa" />
</p>

<p align="center">
  <strong>Label an issue. Walk away. Come back to a PR.</strong>
</p>

<p align="center">
  Lisa is an autonomous issue resolver that turns your backlog into pull requests — no babysitting required.
</p>

---

## Quickstart

```bash
npm install -g @tarcisiopgs/lisa
lisa init
lisa run
```

That's it. Lisa picks up the next labeled issue, implements it, pushes a branch, opens a pull request, and moves the ticket to "In Review" — all without you touching it.

## Try it safely first

Before letting Lisa touch real issues, verify your configuration with `--dry-run`. No issues will be fetched, no code will be written, no PRs will be created.

```bash
lisa run --once --dry-run
```

Example output:

```
[dry-run] Would fetch issue from linear (Engineering/Web App)
[dry-run] Workflow mode: worktree
[dry-run] Models priority: claude/claude-sonnet-4-6
[dry-run] Then implement, push, create PR, and update issue status
```

If the output looks correct, you're ready to run Lisa for real.

## What Lisa Does

Lisa follows a deterministic pipeline:

```
┌─────────┐    ┌──────────┐    ┌───────────┐    ┌──────────┐    ┌────┐    ┌────────┐
│  Fetch   │───▶│ Activate │───▶│ Implement │───▶│ Validate │───▶│ PR │───▶│ Update │
└─────────┘    └──────────┘    └───────────┘    └──────────┘    └────┘    └────────┘
```

1. **Fetch** — Pulls the next issue from Linear, Trello, Plane, Shortcut, GitLab Issues, GitHub Issues, or Jira matching the configured label, team, and project. Issues are sorted by priority. Blocked issues are skipped.
2. **Activate** — Moves the issue to `in_progress` so your team knows it's being worked on.
3. **Implement** — Builds a structured prompt with full issue context and sends it to the AI agent. The agent works in a worktree or branch, implements the change, runs tests, and commits.
4. **Validate** — If the agent's tests pass and pre-push hooks succeed, the branch is pushed. If hooks fail, Lisa re-invokes the agent with the error output and retries.
5. **PR** — Pushes the branch and creates a pull request referencing the original issue. The PR body includes a footer crediting the provider that resolved it.
6. **Update** — Moves the issue to the `done` status and removes the pickup label.
7. **Next** — Picks the next issue. When there are no more matching issues, Lisa stops.

### What makes it different

- **Deterministic, not hopeful** — Each issue follows a structured pipeline with clear stages. No blind retries, no speculative loops.
- **Token efficiency** — Each issue gets one focused prompt. No wasted retries, no idle polling.
- **Multi-repo awareness** — Plans across multiple repos, executes in the correct order, creates one PR per repo.
- **Model fallback** — Configure a chain of models. Transient errors (429, quota, timeout) trigger the next model automatically.
- **Workflow integration** — Issues move through your board in real time. Your team always knows what's being worked on.
- **Self-healing** — Orphan issues stuck in "In Progress" are recovered on startup. Pre-push failures trigger the agent to fix and retry.
- **Guardrails** — Past failures are logged and injected into future prompts so the agent avoids repeating mistakes.

## Providers

| Provider | Key | Command |
|----------|-----|---------|
| Claude Code | `claude` | `claude` |
| Gemini CLI | `gemini` | `gemini` |
| OpenCode | `opencode` | `opencode` |
| GitHub Copilot CLI | `copilot` | `copilot` |
| Cursor Agent | `cursor` | `agent` / `cursor-agent` |
| Goose | `goose` | `goose` |
| Aider | `aider` | `aider` |

At least one provider must be installed and available in your PATH.

> **Cursor Free plan** — `lisa init` automatically detects Free accounts and restricts model selection to `auto` only. On paid plans, a curated list of top-tier models is shown (`composer-1.5`, `opus-4.6`, `sonnet-4.6`, `gpt-5.3-codex`, etc.).

### Fallback Chain

Configure multiple models — Lisa tries each in order. Transient errors (429, quota, timeout, network) trigger the next model; non-transient errors stop the chain.

```yaml
provider: claude
models:
  - claude-sonnet-4-6   # primary
  - claude-opus-4-6     # fallback 1
  - claude-haiku-4-5    # fallback 2
```

## Install

```bash
npm install -g @tarcisiopgs/lisa
```

## Environment Variables

```bash
# Required for PR creation (at least one)
export GITHUB_TOKEN=""    # or have `gh` CLI authenticated

# Required when source = linear
export LINEAR_API_KEY=""

# Required when source = trello
export TRELLO_API_KEY=""
export TRELLO_TOKEN=""

# Required when source = plane
export PLANE_API_TOKEN=""
export PLANE_BASE_URL=""  # optional; defaults to https://api.plane.so
export PLANE_WORKSPACE="" # optional; fallback when team is not set in config

# Required when source = shortcut
export SHORTCUT_API_TOKEN=""

# Required when source = gitlab-issues
export GITLAB_TOKEN=""
export GITLAB_BASE_URL=""  # optional; defaults to https://gitlab.com

# Required when source = github-issues
export GITHUB_TOKEN=""     # same token used for PR creation

# Required when source = jira
export JIRA_BASE_URL=""        # e.g. https://yourcompany.atlassian.net
export JIRA_EMAIL=""           # Atlassian account email
export JIRA_API_TOKEN=""       # Atlassian API token
```

## Commands

| Command | Description |
|---------|-------------|
| `lisa run` | Run the agent loop |
| `lisa run --once` | Process a single issue |
| `lisa run --once --dry-run` | **Recommended first step** — preview config without executing |
| `lisa run --issue ID` | Process a specific issue by identifier or URL |
| `lisa run --limit N` | Process up to N issues |
| `lisa run --dry-run` | Preview without executing |
| `lisa run --provider NAME` | Override AI provider |
| `lisa run --source NAME` | Override issue source |
| `lisa run --label NAME` | Override label filter |
| `lisa run --github METHOD` | Override GitHub method (`cli` or `token`) |
| `lisa run --json` | Output as JSON lines |
| `lisa run --quiet` | Suppress non-essential output |
| `lisa init` | Create `.lisa/config.yaml` interactively |
| `lisa config` | Edit config interactively |
| `lisa config --show` | Print current config as JSON |
| `lisa config --set key=value` | Set a single config value |
| `lisa status` | Show session stats |
| `lisa issue get <id>` | Fetch full issue details as JSON (for use inside worktrees) |
| `lisa issue done <id> --pr-url <url>` | Complete issue, attach PR, update status, remove label |

## TUI

When running in an interactive terminal, `lisa run` renders a real-time Kanban board:

```
┌──────────────────────────┐ ┌───────────────────────────┐ ┌───────────────────────────┐
│ ▶ BACKLOG            [3] │ │ ▶ IN PROGRESS         [1] │ │ ▶ IN REVIEW           [2] │
│                          │ │                           │ │                           │
│ ┌────────────────────┐   │ │ ┌─────────────────────┐   │ │ ┌─────────────────────┐   │
│ │ ENG-42             │   │ │ │ ● ENG-38             │   │ │ │ ✓ ENG-35            │   │
│ │ Add dark mode      │   │ │ │ Fix login redirect   │   │ │ │ Update dependencies │   │
│ │ ready              │   │ │ │ ~1 running           │   │ │ │ PR created          │   │
│ └────────────────────┘   │ │ └─────────────────────┘   │ │ └─────────────────────┘   │
└──────────────────────────┘ └───────────────────────────┘ └───────────────────────────┘
```

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| `Tab` | Move to next column |
| `Shift+Tab` | Move to previous column |
| `↑` / `↓` | Navigate cards / scroll output |
| `Enter` | Open issue detail view (streams provider output) |
| `Esc` | Close detail view, return to board |
| `p` | Pause / resume — loop finishes the current issue then waits |
| `q` | Quit |

The sidebar legend updates contextually: board shortcuts when browsing the Kanban, scroll and back hints when viewing issue detail. The terminal tab title also updates in real time: it shows a spinner with the active issue ID while work is in progress, and a checkmark when done.

## Configuration

Config lives in `.lisa/config.yaml`. Run `lisa init` to create it interactively.

```yaml
provider: claude
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
    match: "[API]"        # route issues whose title starts with "[API]" to this repo
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

| Field | Linear | Trello | Plane | Shortcut | GitLab Issues | GitHub Issues | Jira |
|-------|--------|--------|-------|----------|---------------|---------------|------|
| `team` | Team name | Board name | Workspace slug | Group name (optional) | Project path (`namespace/project`) or numeric ID | `owner/repo` | Project key (e.g. `ENG`) |
| `project` | Project name | — | Project identifier or UUID | — | — | — | — |
| `pick_from` | Status to pick issues from | List to pick cards from | State name to pick issues from | Workflow state to pick stories from | — | — | Status to pick issues from |
| `label` | Label to filter issues | Label to filter cards | Label to filter issues | Label to filter stories | Label to filter issues | Label to filter issues | Label to filter issues |
| `in_progress` | In-progress status | In-progress column | In-progress state name | In-progress workflow state | Label to apply on activate | Label to apply on activate | In-progress status name |
| `done` | Destination status after PR | Destination column after PR | Done state name | Done workflow state | Closes the issue | Closes the issue | Destination status after PR |

Plane example:

```yaml
source: plane
source_config:
  team: my-workspace       # workspace slug (or set PLANE_WORKSPACE env var)
  project: DEV             # project identifier or UUID
  label: ready             # issues with this label are picked up
  pick_from: Todo          # state to fetch issues from
  in_progress: In Progress # state set when Lisa starts working
  done: Done               # state set after PR is created
```

Shortcut example:

```yaml
source: shortcut
source_config:
  label: ready              # stories with this label are picked up
  pick_from: Ready for Development  # workflow state to fetch stories from
  in_progress: In Progress  # state set when Lisa starts working
  done: Done                # state set after PR is created
```

GitLab Issues example:

```yaml
source: gitlab-issues
source_config:
  team: my-org/my-repo     # namespace/project path or numeric project ID
  label: ready              # issues with this label are picked up
  in_progress: in-progress  # label applied when Lisa starts working
  done: ""                  # issue is closed after PR (value unused)
```

GitHub Issues example:

```yaml
source: github-issues
source_config:
  team: my-org/my-repo     # owner/repo
  label: ready              # issues with this label are picked up
  in_progress: in-progress  # label applied when Lisa starts working
  done: ""                  # issue is closed after PR (value unused)
```

Jira example:

```yaml
source: jira
source_config:
  team: ENG                # Jira project key
  label: lisa              # label to filter issues
  pick_from: Backlog       # status to pick issues from
  in_progress: In Progress # status applied when Lisa starts working
  done: In Review          # status applied after PR is created
```

### Workflow Modes

**Branch** — The AI agent creates a branch directly in your current checkout, implements the changes, and pushes. Simple setup, works everywhere.

**Worktree** — Lisa creates an isolated [git worktree](https://git-scm.com/docs/git-worktree) for each issue under `.worktrees/`. The agent works in the worktree without touching your main checkout. After the PR is created, the worktree is cleaned up automatically. Ideal when you want to keep working in the repo while Lisa resolves issues in the background.

**Multi-repo worktree** — When multiple repos are configured, Lisa runs a two-phase flow: a planning agent produces a `.lisa-plan.json` with ordered steps, then Lisa executes each step sequentially — one worktree and one PR per repo. Cross-repo context (branch names, PR URLs) is passed to each subsequent step.

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

### Recovery Mechanisms

- **Orphan recovery** — On startup, Lisa scans for issues stuck in `in_progress` from interrupted runs and reverts them to `pick_from`.
- **Push recovery** — If `git push` fails due to pre-push hooks (linter, typecheck, tests), Lisa re-invokes the agent with the error output and retries the push.
- **Signal handling** — SIGINT/SIGTERM gracefully revert the active issue to its previous status before exiting.
- **Guardrails** — Failed sessions are logged to `.lisa/guardrails.md` and injected into future prompts so the agent avoids repeating the same mistakes.

### Overseer

When enabled, the overseer periodically checks `git status` in the working directory. If no changes are detected within `stuck_threshold` seconds, the provider process is killed and the error is eligible for fallback to the next model.

### Auto-Detection

Lisa auto-detects `vitest` or `jest` from `package.json` dependencies and injects the correct test command into the agent prompt. It also detects the package manager from lockfiles (`bun.lockb`/`bun.lock` → `bun`, `pnpm-lock.yaml` → `pnpm`, `yarn.lock` → `yarn`, otherwise `npm`).

## License

[MIT](LICENSE)
