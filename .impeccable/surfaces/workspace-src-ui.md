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
FIRST VIEWPORT: left sidebar 28 columns by default (adjustable from 20 to 48 with `<` and `>`), then a 1-column dim `│` separator, then the agent pane filling the rest, full height minus one footer line, no border. Sidebar: project and group rows (`▾ api`, bold) in one alphabetical list, with worktree rows under them (`▐ ◉ fix-login`). Under a group, the agents of all its repositories, each ending in a dim right-aligned repository tag (`◉ fix-ingest-lag     api`); a repository without agents takes no row. A folded group shows the glyph of its most urgent agent on the right. Footer: two legends, the sidebar's on the left and the agent's on the right. Sidebar focused: the left legend follows the selected row (running worktree `⏎ open · n new · s stop · e rename · d remove · ? keys`; stopped worktree with `r restart` in place of `s stop`; project `⏎ fold · n new · e rename · ? keys`; group adds `d ungroup`), and the right one is `^a agent · <worktree> · <agent>` when one is open. Pane focused: left `^a sidebar`, right `project/worktree · agent` (+ `· full autonomy` in yellow). The empty pane hint follows the selection too: `⏎ opens <worktree>` or `n starts a worktree in <project or group>`. Sidebar collapses to a 3-column glyph rail under 100 columns.
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
  - `e` rename: a project's alias, a group's name, or a worktree's name and local branch
  - `b` change base branch
  - `d` remove a worktree, or ungroup a group
  - `<` `>` narrow or widen the sidebar, one column per press
  - `r` restart the agent (only when exited)
  - `s` stop the agent
  - `?` help overlay
  - `q` quit (agents keep running; on the way out Lisa prints how many and how to come back)
  - `Q` stop every agent and quit, after a confirmation
  - The help overlay lists the keys in two sections, `ANYWHERE` and `SIDEBAR`.
- Mouse: a click on a sidebar row does what `⏎` does there (open a worktree, fold a project or group); a click on the pane focuses the agent. The wheel moves the selection over the sidebar and scrolls the agent's history over the pane; agents that ask for the mouse receive it instead. No mouse under a dialog. Selecting text is Shift + drag, done by the terminal.
- Dialogs are centred single-border boxes with a cyan title.
  - New worktree, step 1: the task alone, always, with `⏎ continue · esc cancel` (`⏎ skip` while it is empty).
  - Rename (`e`) happens in the sidebar row itself, never in a box on the agent side: the name becomes editable in place (`▐▾ Tarcísio Pedro▏`), keeping its end and the cursor in view, and the footer speaks only about it, from the left edge: `branch: <sanitized> · ⏎ rename · esc cancel` for a worktree, `⏎ rename · empty restores the folder name · esc cancel` for a project.
  - Quit everything (`Q`): `Stop N agents and quit?`, a dim line saying worktrees and branches are kept, `y stop and quit · esc cancel`. With no agent running, `Q` just quits.
  - New worktree, step 2: no name and no task. The router's verdict takes the first line (`asking Jev…` in yellow, `Jev suggests claude · haiku · 76% sure`, `Jev is unsure · using your default`, or the failure reason in dim), with `task is not sent to <agent>` dim under it. Then the agent list (unavailable ones dim with `not installed`), model (`‹ opus ›   effort ‹ high ›`, only for agents with a verified catalog; arrows turn yellow in focus), permission (normal / full autonomy; disabled with a reason when unsupported), a `fetching origin/main…` line while the daemon works. The worktree is named from the word list and renamed later with `e`.
  - A documented cost note takes one dim line under the model.
  - On short terminals the dialog shrinks in this order: blank separators removed, then the agent list windowed around the selection. The focused field and the hint line always stay.
  - Add project: a folder picker, never a bare path field. A dim line with the listed folder (`~/Workspace/`, plus `15/35` on the right when the list overflows), the filter line (`› glo▏`), then the subfolders: git repositories first with `●`, plain folders dim with a trailing `/`, already mapped repositories dim with `added` on the right. Hidden folders appear only when the filter starts with a dot.
    - Typing filters by case-insensitive subsequence, closest match first. `↑↓` move, `→`/`Tab` open the folder, `←` (or `Backspace` on an empty filter) goes up, `⏎` adds a repository or opens a plain folder.
    - A filter starting with `/` or `~` is a path: the list follows the typed folder and filters by the last segment. A pasted path replaces the filter.
    - It opens beside the last mapped project; with none, where Lisa was started, then the home folder.
    - The list height follows the folder (up to ten rows), not the filter, so the box does not jump while typing. The hint line names what `⏎` does for the selected row.
    - `no folders here`, `no match` (dim) and `Cannot open this folder: <reason>` (red) take the first list row.
    - Groups: `^f` on a plain folder adds it as a group made of the repositories directly inside it. `^n` starts a new group: a name first (`› Name  Glowz▏`), then the same list with `space` marking repositories in any folder (`✔` in green), `<name> · N marked` on the right of the folder line, and `⏎` creating the group. Already mapped repositories can be marked and move into the group. Why a key did nothing (`no repositories in this folder`, `mark at least one repository`, a name already taken) shows in red on the line above the hints until the next key. The title becomes `New group`.
  - New worktree from a group: the title names the group and a `Repo` field comes first (`› Repo    ‹ api ›  1 of 6`). `←→` cycle the repositories and a letter jumps to the next tag starting with it. It opens on the selected agent's repository; from the group row, on the last one used in that group.
  - Ungroup: `Ungroup <name>?`, two dim lines saying the repositories become standalone projects and nothing is deleted, `y ungroup · esc cancel`.
  - Remove: `y remove · n cancel`; `⏎` does not confirm, because the folder and the local branch are deleted. A refusal shows the reason in red with `f force · esc cancel`. For a worktree whose folder is already gone, the box says `Its folder is already gone.` and `Only the list entry is removed.`, and `⏎` or `y` confirms (`⏎ remove from list · esc cancel`). No line of this dialog may wrap: a wrapped line pushes the key hints out of the box, so names are cut with `…`.

## Empty and edge states

- No agent open (with or without projects): the welcome, centred in the pane. The wordmark `LISA` in block letters (yellow), the tagline `Map projects. Run agents. Stay in the terminal.` (dim), the steps for the selected row (`⏎  opens <worktree>` or `n  starts a worktree in <project or group>`, then `p  adds a project or a group` and `?  shows every key`), and a summary line `1 needs you · 2 working · 1 done` (needs-you in red) with the version on the right. Short or narrow panes swap the wordmark for `LISA` on one line and drop the tagline and the least urgent counts whole.
- Project without worktrees: a dim `no worktrees · n` row.
- Group without agents: the same dim `no worktrees · n` row.
- History: while the pane shows scrollback, its last row reads `↑ N lines back · scroll down or type to return` in dim and the agent's cursor is hidden.
- Exited agent: the last screen dimmed with a bottom banner `agent exited (code N) · r restart`.
- Broken worktree: the pane says `Worktree missing on disk · d remove from list`.
- Notices (yellow) and errors (red) take over the footer for 5 s.
- Terminal smaller than 60×12: a centred `Terminal too small (need 60×12)`.
- Daemon from another version with running agents: a dialog with `keep running · restart agents · quit`; keep is disabled when the protocol differs.
- Another UI attached: a full-screen message, then exit.
