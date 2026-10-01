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
STORY: the user sees the agent at work, glances left to see which worktrees need them (shape and colour), jumps there with two keys and answers. Notifications do the rest when they are elsewhere.
FIRST VIEWPORT: left sidebar 28 columns by default (adjustable from 20 to 48 with `<` and `>`), then a 1-column dim `│` separator, then the agent pane filling the rest, full height minus one footer line, no border. Sidebar: project and group rows (`▾ api`, bold) in one alphabetical list, with worktree rows under them (`▐ ◉ fix-login`). Under a group, the agents of all its repositories, each ending in a dim right-aligned repository tag (`◉ fix-ingest-lag     api`); a repository without agents takes no row. A folded group shows the glyph of its most urgent agent on the right. Footer: left, the focused worktree `project/worktree · agent` (+ `· full autonomy` in yellow). Right, hints for the focused zone: pane → `^a menu`; sidebar → `⏎ open · n new · p project · d remove · r restart · ? help · q quit`. Sidebar collapses to a 3-column glyph rail under 100 columns.
FORM: sidebar left, agent right (the maintainer moved the sidebar from the right on 2026-10-01; originally position 6 of 7, seed key 6e05fd8d); user steer: close to the original Lisa and devsweep, small navigation menu, everything else is the agent.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## State vocabulary (shape-distinct, not colour-only)

working `◉` yellow · needs you `◆` red bold · done `✔` green · idle `○` dim · exited with error `✖` red dim · broken worktree `⊘` dim.

## Interaction

- Two focus zones. The pane receives every key except the prefix `Ctrl-a`. `Ctrl-a Ctrl-a` sends a literal Ctrl-a.
- `Ctrl-a` moves focus to the sidebar. There, `↑↓`/`jk` move, `⏎` opens the worktree in the pane (and focuses it), `Tab` jumps to the next worktree that needs you or is done, `Esc` returns to the pane.
- Sidebar actions:
  - `n` new worktree in the selected project or group
  - `p` add project or group
  - `b` change base branch
  - `d` remove a worktree, or ungroup a group
  - `<` `>` narrow or widen the sidebar, one column per press
  - `r` restart the agent (only when exited)
  - `s` stop the agent
  - `?` help overlay
  - `q` detach (agents keep running)
- Dialogs are centred single-border boxes with a cyan title.
  - New worktree: name (with a dim `branch: <sanitized>` preview), task (optional, up to three wrapped rows, dim placeholder when empty), agent list (unavailable ones dim with `not installed`), model (`‹ opus ›   effort ‹ high ›`, only for agents with a verified catalog; arrows turn yellow in focus), permission (normal / full autonomy; disabled with a reason when unsupported), a `fetching origin/main…` line while the daemon works.
  - Routing marks sit dim on the agent row: `routing…` (yellow) while waiting, `suggested · 86%`, `unsure · your default`. A failure reason or `task is not sent to <agent>` takes one dim line under the task; a documented cost note takes one dim line under the model.
  - On short terminals the dialog shrinks in this order: task to one row, blank separators removed, agent list windowed around the selection. The focused field and the hint line always stay.
  - Add project: a folder picker, never a bare path field. A dim line with the listed folder (`~/Workspace/`, plus `15/35` on the right when the list overflows), the filter line (`› glo▏`), then the subfolders: git repositories first with `●`, plain folders dim with a trailing `/`, already mapped repositories dim with `added` on the right. Hidden folders appear only when the filter starts with a dot.
    - Typing filters by case-insensitive subsequence, closest match first. `↑↓` move, `→`/`Tab` open the folder, `←` (or `Backspace` on an empty filter) goes up, `⏎` adds a repository or opens a plain folder.
    - A filter starting with `/` or `~` is a path: the list follows the typed folder and filters by the last segment. A pasted path replaces the filter.
    - It opens beside the last mapped project; with none, where Lisa was started, then the home folder.
    - The list height follows the folder (up to ten rows), not the filter, so the box does not jump while typing. The hint line names what `⏎` does for the selected row.
    - `no folders here`, `no match` (dim) and `Cannot open this folder: <reason>` (red) take the first list row.
    - Groups: `^f` on a plain folder adds it as a group made of the repositories directly inside it. `^n` starts a new group: a name first (`› Name  Glowz▏`), then the same list with `space` marking repositories in any folder (`✔` in green), `<name> · N marked` on the right of the folder line, and `⏎` creating the group. Already mapped repositories can be marked and move into the group. Why a key did nothing (`no repositories in this folder`, `mark at least one repository`, a name already taken) shows in red on the line above the hints until the next key. The title becomes `New group`.
  - New worktree from a group: the title names the group and a `Repo` field comes first (`› Repo    ‹ api ›  1 of 6`). `←→` cycle the repositories and a letter jumps to the next tag starting with it. It opens on the selected agent's repository; from the group row, on the last one used in that group.
  - Ungroup: `Ungroup <name>?`, two dim lines saying the repositories become standalone projects and nothing is deleted, `y ungroup · esc cancel`.
  - Remove: `y/N` confirmation. A refusal shows the reason in red with `f force · esc cancel`.

## Empty and edge states

- No projects: a centred message in the pane area, `No projects yet` and `p add a project`.
- Project without worktrees: a dim `no worktrees · n` row.
- Group without agents: the same dim `no worktrees · n` row.
- Exited agent: the last screen dimmed with a bottom banner `agent exited (code N) · r restart`.
- Broken worktree: the pane says `Worktree missing on disk · d remove from list`.
- Notices (yellow) and errors (red) take over the footer for 5 s.
- Terminal smaller than 60×12: a centred `Terminal too small (need 60×12)`.
- Daemon from another version with running agents: a dialog with `keep running · restart agents · quit`; keep is disabled when the protocol differs.
- Another UI attached: a full-screen message, then exit.
