---
name: Lisa Workspace
description: A terminal multiplexer for coding agents, with just enough opinion to show what each one is doing.
---

# Design System: Lisa Workspace

The frontmatter carries no color, type, radius or spacing tokens on purpose. This is a terminal UI: colors are the terminal's named ANSI colors, the typeface and its size belong to the user's terminal, and the unit of space is the character cell. The values below are the normative ones, taken from `src/ui/render.rs` and `src/ui/app.rs`.

## Overview

**Creative North Star: "The tmux with an opinion"**

Lisa Workspace is a sober multiplexer. Almost everything on screen is text in the terminal's default color, and the agent's own terminal takes all the room it can get. Lisa adds only the minimum needed to know what each agent is doing: one glyph per agent, one line per agent, one line of footer.

Color is a signal, not decoration. A screen where nothing needs the user is nearly monochrome. Yellow marks where the user is and what is moving; red marks what is waiting on them; green marks what finished.

**Key Characteristics:**

- The agent pane dominates; the sidebar is a narrow index.
- One line per agent, no previews and no cards.
- State is carried by shape first and color second.
- Named ANSI colors only, so the user's terminal theme decides the actual hues.
- Dialogs are the only boxed surfaces.

## Colors

Four named ANSI colors plus the terminal default, each with one job.

### Primary

- **Focus Yellow** (ANSI `Yellow`): the selection bar when the sidebar has focus, the working glyph, the active field marker `›`, the text cursor `▏`, the selected option in a dialog, and warnings.

### Secondary

- **Dialog Cyan** (ANSI `Cyan`, bold): dialog titles only.

### Tertiary

- **Needs-You Red** (ANSI `Red`): the needs-you glyph (bold), errors, refusals, and the failed-exit glyph (dim).
- **Done Green** (ANSI `Green`): the done glyph.

### Neutral

- **Terminal Default** (no color set): names, body text, dialog borders.
- **Dim** (the `DIM` modifier on the default color): the `PROJECTS` header, the vertical separator, idle and broken glyphs, inactive field labels, hints, the footer.
- **Bold** (the `BOLD` modifier): project names, the open worktree, the active field label.

### Named Rules

**The Shape-First Rule.** Every state has its own glyph. Color reinforces a state; it never is the state.

**The Quiet Screen Rule.** If no agent needs the user, nothing on screen is red. Red is reserved for what blocks on a person.

**The Theme-Is-Theirs Rule.** Never use RGB or indexed colors for Lisa's own chrome. RGB and indexed colors appear only inside the agent pane, where they are the agent's output passed through.

## Typography

The typeface, size and line height are the user's terminal's. Hierarchy comes from three treatments only.

### Hierarchy

- **Title** (bold): project names, the open worktree, the active field label.
- **Body** (default): worktree names, dialog text.
- **Label** (dim; dim and bold for the uppercase `PROJECTS` header): section header, hints, inactive labels, footer.

### Named Rules

**The Three Weights Rule.** Bold, default and dim. Italic, underline and reverse are not part of Lisa's chrome.

## Layout

- **Frame:** sidebar on the left, a one-column dim `│` separator, the agent pane filling the rest, and a one-row footer across the full width.
- **Sidebar:** 28 columns wide by default when the terminal is at least 100 columns, adjustable from 20 to 48 with `<` and `>`. Below 100 columns it becomes a 3-column glyph rail showing only the selection bar and the state glyph; the full sidebar overlays the pane while the user navigates.
- **Minimum:** 60×12. Smaller terminals show a single dim line asking for more room.
- **Sidebar rows:** the first column is reserved for the selection bar and the last one stays empty. A project or group row is the bar, a `▾`/`▸` arrow and the name. A worktree row is the bar, two spaces of indent, the glyph and the name. An empty project or group shows a dim hint in the worktree position.
- **Order:** groups and standalone projects share one alphabetical list. Under a group, agents are ordered by repository tag.
- **Footer:** the current `project/worktree · agent` on the left, key hints on the right, both dim.
- **Dialogs:** 56 columns wide, centered in the pane, with a label column of 10 cells. They drop optional rows before they drop the focused field and the hints.
- **Truncation:** names are cut to the available width, never wrapped. Only the task text in a dialog wraps. When a name and a repository tag compete, the name is cut and the tag stays whole.

## Elevation & Depth

Flat. There are no shadows or tonal layers. A dialog clears the cells under it and draws a border; that is the only form of layering.

## Shapes

Plain single-line box drawing (`┌ ─ ┐ │ └ ┘`) for dialogs, and a single `│` for the sidebar separator. No rounded, double or thick borders. The sidebar and the pane have no border of their own.

Glyph vocabulary:

- `▐` selection bar
- `▾` / `▸` expanded / collapsed project
- `◉` working
- `◆` needs you
- `✔` done
- `○` idle, or stopped cleanly
- `✖` exited with an error
- `⊘` broken worktree
- `·` project position in the glyph rail
- `›` active field
- `▏` text cursor
- `●` / `○` and `(•)` / `( )` selected / unselected option
- `✔` in green, in the folder picker: repository marked for the group being created
- `‹ value ›` a value changed with the arrow keys

## Components

### Sidebar row

One line. The selection bar is yellow when the sidebar has focus and dim when the pane has it. The worktree that is open in the pane is bold. Broken worktrees are dim throughout.

### Grouped agent row

The sidebar row of an agent that belongs to a group ends with its repository tag: dim, right-aligned, at most 8 columns. Standalone projects carry no tag, and that absence is what tells the two apart.

### Folded group

A folded group shows, right-aligned, the glyph of the most urgent state among its agents: needs you, then working, then done. It shows nothing when every agent is idle.

### State glyph

Working is yellow `◉`; needs you is bold red `◆`; done is green `✔`; idle is dim `○`. A stopped agent is dim `○`, or dim red `✖` when it exited with a non-zero code.

### Dialog

A plain bordered box with a bold cyan title set into the top border. Fields are a label and a value on one line; the active field has a yellow `›` and a bold label, the others a dim label. Notes about a field sit dim under it. The last line is always the key hints, dim, separated by ` · `.

### Notices

Inline, on the line where they apply: yellow for warnings, red for errors and refusals. A refusal states the reason and names the key that forces the action.

### Footer and banners

One dim line. A banner about the current agent (for example an exit and how to restart) sits on the last row of the pane, above the footer.

## Do's and Don'ts

### Do:

- **Do** keep one line per agent in the sidebar.
- **Do** keep repositories without agents out of the sidebar; they belong in the launch dialog.
- **Do** give every new state or kind of row its own glyph before giving it a color.
- **Do** use yellow for focus and activity, red only for what waits on the user.
- **Do** put key hints in the footer or on the last line of a dialog, dim, separated by ` · `.
- **Do** keep a working layout at 60×12 and a glyph rail below 100 columns.

### Don't:

- **Don't** add cards, multi-line previews of the conversation or per-row metadata blocks to the sidebar.
- **Don't** set RGB or indexed colors in Lisa's own chrome.
- **Don't** box the sidebar or the pane; borders belong to dialogs.
- **Don't** wrap names in the sidebar; truncate them.
- **Don't** signal a state by color alone.
