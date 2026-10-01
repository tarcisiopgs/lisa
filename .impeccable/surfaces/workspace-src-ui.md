---
version: 1
slug: "workspace-src-ui"
primary_target: "workspace/src/ui"
related_targets: []
---

# Workspace mode — terminal surface

Scope: the Workspace mode TUI (`workspace/src/ui/`). Visitor mode: Operate.
Audience and job: the maintainer juggling several coding agents across projects; answer the agent that needs them, start new worktrees, switch fast.
Constraints: spec R6–R15; one state per worktree; Ghostty/iTerm2/kitty/WezTerm; dark and light themes (ANSI named colours only).

## Direction contract

THESIS: the agent's terminal is the screen. Lisa is a narrow navigation column that frames it, never an app with panels that compete with it. Refuses the Orca arrangement (three columns, chips, tabs, status bar meters).
OWN-WORLD: inherited from Lisa's Kanban and devsweep. Plain single-line rules, ANSI named colours only (yellow = selection and activity, red = needs you and errors, green = done, gray/dim = idle and chrome), BOLD and DIM modifiers, the `▐` selection bar, uppercase section labels, one dim footer line with `key action · key action` hints.
STORY: the user sees the agent at work, glances right to see which worktrees need them (shape and colour), jumps there with two keys and answers. Notifications do the rest when they are elsewhere.
FIRST VIEWPORT: agent pane on the left, full height minus one footer line, no border. 1-column dim `│` separator. Right sidebar 28 columns: project rows (`▾ api`, bold) with worktree rows under them (`▐ ◉ fix-login`). Footer: left, the focused worktree `project/worktree · agent` (+ `· full autonomy` in yellow). Right, hints for the focused zone: pane → `^a menu`; sidebar → `⏎ open · n new · p project · d remove · r restart · ? help · q quit`. Sidebar collapses to a 3-column glyph rail under 100 columns.
FORM: position 6 of 7 (agent-left, sidebar right), seed key 6e05fd8d; user steer: close to the original Lisa and devsweep, small navigation menu, everything else is the agent.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## State vocabulary (shape-distinct, not colour-only)

working `◉` yellow · needs you `◆` red bold · done `✔` green · idle `○` dim · exited with error `✖` red dim · broken worktree `⊘` dim.

## Interaction

- Two focus zones. The pane receives every key except the prefix `Ctrl-a`. `Ctrl-a Ctrl-a` sends a literal Ctrl-a.
- `Ctrl-a` moves focus to the sidebar. There, `↑↓`/`jk` move, `⏎` opens the worktree in the pane (and focuses it), `Tab` jumps to the next worktree that needs you or is done, `Esc` returns to the pane.
- Sidebar actions:
  - `n` new worktree in the selected project
  - `p` add project
  - `b` change base branch
  - `d` remove
  - `r` restart the agent (only when exited)
  - `s` stop the agent
  - `?` help overlay
  - `q` detach (agents keep running)
- Dialogs are centred single-border boxes with a cyan title.
  - New worktree: name (with a dim `branch: <sanitized>` preview), task (optional, up to three wrapped rows, dim placeholder when empty), agent list (unavailable ones dim with `not installed`), model (`‹ opus ›   effort ‹ high ›`, only for agents with a verified catalog; arrows turn yellow in focus), permission (normal / full autonomy; disabled with a reason when unsupported), a `fetching origin/main…` line while the daemon works.
  - Routing marks sit dim on the agent row: `routing…` (yellow) while waiting, `suggested · 86%`, `unsure · your default`. A failure reason or `task is not sent to <agent>` takes one dim line under the task; a documented cost note takes one dim line under the model.
  - On short terminals the dialog shrinks in this order: task to one row, blank separators removed, agent list windowed around the selection. The focused field and the hint line always stay.
  - Remove: `y/N` confirmation. A refusal shows the reason in red with `f force · esc cancel`.

## Empty and edge states

- No projects: a centred message in the pane area, `No projects yet` and `p add a project (path to a git repository)`.
- Project without worktrees: a dim `no worktrees · n` row.
- Exited agent: the last screen dimmed with a bottom banner `agent exited (code N) · r restart`.
- Broken worktree: the pane says `Worktree missing on disk · d remove from list`.
- Notices (yellow) and errors (red) take over the footer for 5 s.
- Terminal smaller than 60×12: a centred `Terminal too small (need 60×12)`.
- Daemon from another version with running agents: a dialog with `keep running · restart agents · quit`; keep is disabled when the protocol differs.
- Another UI attached: a full-screen message, then exit.
