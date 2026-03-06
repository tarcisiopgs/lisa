# Lisa

<p align="center">
  <strong>Label an issue. Walk away. Come back to a PR.</strong>
</p>

<p align="center">
  <img src="assets/demo.gif?v=2" alt="Lisa demo" width="800" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@tarcisiopgs/lisa"><img src="https://img.shields.io/npm/v/@tarcisiopgs/lisa.svg" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@tarcisiopgs/lisa"><img src="https://img.shields.io/npm/dm/@tarcisiopgs/lisa.svg" alt="npm downloads" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT" /></a>
  <img src="https://img.shields.io/node/v/%40tarcisiopgs%2Flisa" alt="Node.js version" />
</p>

---

## Quickstart

```bash
npm install -g @tarcisiopgs/lisa
lisa init        # interactive setup — picks your source + provider
lisa run         # start resolving issues
```

Verify your setup first with `lisa run --once --dry-run` — no issues will be fetched, no code written, no PRs created.

Lisa picks up the next labeled issue, implements it, pushes a branch, opens a pull request, and moves the ticket to "In Review" — all without you touching it.

---

## How It Works

```
┌─────────┐    ┌──────────┐    ┌───────────┐    ┌──────────┐    ┌────┐    ┌────────┐
│  Fetch   │───▶│ Activate │───▶│ Implement │───▶│ Validate │───▶│ PR │───▶│ Update │
└─────────┘    └──────────┘    └───────────┘    └──────────┘    └────┘    └────────┘
```

1. **Fetch and activate** — Pulls the next priority-sorted issue matching your configured label and moves it to `in_progress`.
2. **Implement** — Builds a structured prompt with full issue context and sends it to the AI agent. The agent works in a worktree or branch, implements the change, runs tests, and commits.
3. **Push and PR** — Pushes the branch, creates a pull request referencing the original issue. If pre-push hooks fail, re-invokes the agent with the error output and retries.
4. **Update and loop** — Moves the issue to `done`, removes the pickup label, and picks the next issue. Stops when the queue is empty.

---

## Issue Sources

| Source | Key |
|--------|-----|
| Linear | `linear` |
| GitHub Issues | `github-issues` |
| Jira | `jira` |
| GitLab Issues | `gitlab-issues` |
| Trello | `trello` |
| Plane | `plane` |
| Shortcut | `shortcut` |

---

## AI Providers

| Provider | Key | Command |
|----------|-----|---------|
| Claude Code | `claude` | `claude` |
| Gemini CLI | `gemini` | `gemini` |
| OpenCode | `opencode` | `opencode` |
| GitHub Copilot CLI | `copilot` | `copilot` |
| Cursor Agent | `cursor` | `agent` / `cursor-agent` |
| Goose | `goose` | `goose` |
| Aider | `aider` | `aider` |
| OpenAI Codex | `codex` | `codex` |

At least one provider must be installed and available in your PATH.

### Fallback Chain

Configure multiple models — Lisa tries each in order. Transient errors (429, quota, timeout, network) trigger the next model automatically.

```yaml
provider: claude
models:
  - claude-sonnet-4-6   # primary
  - claude-opus-4-6     # fallback 1
  - claude-haiku-4-5    # fallback 2
```

---

## PR Platforms

| Platform | Key | Auth |
|----------|-----|------|
| GitHub CLI | `cli` | `gh auth login` |
| GitHub API | `token` | `GITHUB_TOKEN` |
| GitLab | `gitlab` | `GITLAB_TOKEN` |
| Bitbucket | `bitbucket` | `BITBUCKET_TOKEN` + `BITBUCKET_USERNAME` |

---

## Environment Variables

Set the tokens for your chosen source and PR platform:

```bash
# PR platform
GITHUB_TOKEN          # GitHub (platform: cli or token)
GITLAB_TOKEN          # GitLab (platform: gitlab)
BITBUCKET_TOKEN       # Bitbucket app password (platform: bitbucket)
BITBUCKET_USERNAME    # Bitbucket username

# Issue sources
LINEAR_API_KEY        # source: linear
TRELLO_API_KEY        # source: trello
TRELLO_TOKEN
SHORTCUT_API_TOKEN    # source: shortcut
PLANE_API_TOKEN       # source: plane
PLANE_BASE_URL        # optional, defaults to https://api.plane.so
GITLAB_TOKEN          # source: gitlab-issues
GITLAB_BASE_URL       # optional, defaults to https://gitlab.com
GITHUB_TOKEN          # source: github-issues
JIRA_BASE_URL         # source: jira (e.g. https://yourorg.atlassian.net)
JIRA_EMAIL
JIRA_API_TOKEN        # generate at id.atlassian.com — expires, regenerate if 401

# Aider provider (one of)
GEMINI_API_KEY
OPENAI_API_KEY
ANTHROPIC_API_KEY
```

---

## Commands

| Command | Description |
|---------|-------------|
| `lisa run` | Run the agent loop |
| `lisa run --once` | Process a single issue |
| `lisa run --once --dry-run` | Preview config without executing |
| `lisa run --watch` | Poll for new issues every 60s after queue empties |
| `lisa run --issue ID` | Process a specific issue by identifier or URL |
| `lisa run --concurrency N` | Process N issues in parallel (each in its own worktree) |
| `lisa init` | Create `.lisa/config.yaml` interactively |
| `lisa config --show` | Print current config |
| `lisa status` | Show session stats |

Run `lisa run --help` for all available flags.

---

## Configuration

Config lives in `.lisa/config.yaml`. Run `lisa init` to create it interactively.

```yaml
provider: claude
source: linear
workflow: worktree          # "worktree" (isolated) or "branch" (in-place)

source_config:
  team: Engineering
  project: Web App
  label: ready
  pick_from: Backlog
  in_progress: In Progress
  done: In Review

platform: cli               # "cli", "token", "gitlab", or "bitbucket"
workspace: .
base_branch: main

# Multi-repo (optional)
repos:
  - name: my-api
    path: ./api
    base_branch: main
    match: "[API]"           # route issues by title prefix
  - name: my-app
    path: ./app
    base_branch: main

loop:
  cooldown: 10               # seconds between issues
  max_sessions: 0            # 0 = unlimited
  session_timeout: 0         # seconds per provider run (0 = disabled)

# Optional — kill stuck providers
overseer:
  enabled: true
  check_interval: 30         # seconds between git status checks
  stuck_threshold: 300       # seconds without changes before killing

# Optional — skip issues without acceptance criteria
validation:
  require_acceptance_criteria: true
```

### Source-specific notes

**GitHub Issues / GitLab Issues** — `pick_from`, `in_progress`, and `done` are **labels**, not statuses. Make sure `in_progress` differs from `pick_from`; using the same value causes Lisa to re-pick issues that are already being worked on.

**Trello** — `team`, `pick_from`, `in_progress`, and `done` are list **names** (not IDs).

**Jira** — `team` is your project **key** (e.g. `ENG`). `JIRA_API_TOKEN` is generated at [id.atlassian.com](https://id.atlassian.com) and expires — regenerate if you get 401 errors.

**Goose** — `lisa init` asks which backend to use (gemini-cli, anthropic, openai, etc.) and saves it to config. No env vars needed. You can also set `GOOSE_PROVIDER` manually — it takes precedence over the config value.

**Aider** — requires a direct LLM API key (`GEMINI_API_KEY`, `OPENAI_API_KEY`, or `ANTHROPIC_API_KEY`). Does not support OAuth or cached credentials.

**OpenCode** — if `~/.config/opencode/config.json` contains MCP entries, remove them or set the file to `{}` to prevent OpenCode from hanging on startup.

---

### Workflow Modes

**Branch** — The agent creates a branch in your current checkout. Simple setup, works everywhere.

**Worktree** — Lisa creates an isolated git worktree per issue under `.worktrees/`. Your main checkout stays untouched. Cleaned up automatically after the PR is created.

When `--concurrency` is greater than 1, worktree mode is enforced automatically.

---

### Session Timeout

If a provider hangs (e.g. misconfigured model, network issue), Lisa can kill it after a configurable duration:

```yaml
loop:
  session_timeout: 300  # kill provider after 5 minutes (0 = disabled, default)
```

When the timeout fires, the provider process is killed and the error is eligible for fallback — Lisa will try the next model in your chain. This is disabled by default so long-running sessions work uninterrupted.

---

## Writing Issues

Issue quality is the single biggest factor in PR quality. Lisa validates issues before accepting them — vague tickets without clear criteria are skipped and labelled `needs-spec`.

Issues must contain acceptance criteria: markdown checklists (`- [ ]`) or keywords like `acceptance criteria`, `expected`, `should`.

### Example

```markdown
Title: Add rate limiting to /api/users endpoint

Description:
Implement rate limiting on the `/api/users` endpoint to prevent abuse.

Relevant files:
- src/routes/users.ts
- src/middleware/auth.ts

Acceptance criteria:
- [ ] Requests exceeding 100/min per IP return HTTP 429
- [ ] Rate limit headers (X-RateLimit-Limit, X-RateLimit-Remaining) included in all responses
- [ ] Rate limit state stored in Redis (use existing connection from src/lib/redis.ts)
- [ ] Existing tests still pass

Stack: Express, Redis
```

Including **relevant files**, **technical constraints**, and **stack information** in the description leads to better results.

---

## License

[MIT](LICENSE)
