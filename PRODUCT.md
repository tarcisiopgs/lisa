# Product

<!-- impeccable:product-schema 1 -->

## Platform

terminal

Lisa is a terminal application (not web, iOS or Android). It has two interfaces: the Autonomous mode Kanban board (TypeScript, ink) and the Workspace mode (Rust, ratatui).

## Users

The reference user is the maintainer: a developer who works across many projects every day and runs several coding agents (Claude Code, Codex and others) in parallel git worktrees. Decisions may favour this workflow. Lisa stays public on npm for open-source developers who work the same way; they come second.

## Product Purpose

Lisa has two modes:

- **Autonomous:** connects an issue tracker to an AI coding agent and delivers pull requests without supervision ("Plan issues. Run agents. Get PRs.").
- **Workspace:** keeps projects mapped in a sidebar, spins up a git worktree from a project's base branch whenever the user wants, and runs any supported agent interactively inside that worktree, rendered by Lisa itself. A Lisa daemon keeps the agents alive when the UI closes, and Lisa notifies the user whenever an agent needs attention or finishes.

Success for Workspace mode is replacing the maintainer's daily use of Orca without Orca's visual clutter.

## Positioning

- Terminal-native, with no Electron and no tmux prerequisite.
- Project-first: the user maps a project once and works from it, instead of opening the tool inside a repository folder (the flow of herdr and claude-squad).
- One mode for autonomous issue delivery and one for interactive agent work, in the same CLI.

## Operating Context

The user lives in a terminal, primarily Ghostty. Several agents run at the same time across projects. The user switches between them, answers permission prompts and reviews results. Often the terminal window is not focused and the user is in another app, so notifications carry the workflow.

## Capabilities and Constraints

- Supported terminals: Ghostty, iTerm2, kitty and WezTerm. Terminal.app and IDE-embedded terminals are not targets.
- Supported platforms: macOS and Linux. Windows is not supported in Workspace mode.
- Ten agents: Claude Code, Gemini CLI, OpenCode, GitHub Copilot CLI, Cursor Agent, Goose, Aider, Codex, Kilo Code and MiMo Code. Not all of them offer full autonomy or resume in interactive mode.
- Workspace v1 scope:
  - one agent terminal per worktree
  - exactly four agent states: working, needs you, done and idle
  - no diff view, no tracker integrations and no PR actions
- Terminology:
  - "project": a mapped git repository
  - "worktree": a git worktree created from the project's base branch
  - "agent": the coding CLI running in a worktree
- Specification of record: the maintainer's vault note "2026-09-30 - Modo Workspace" (R1–R15, AE1–AE6).

## Brand Commitments

The name is Lisa. The README voice is terse and imperative ("Plan issues. Run agents. Get PRs.").

**Undecided:** accessibility commitments, such as distinguishing states without relying on colour or supporting light terminal themes, were raised but not decided.

## Evidence on Hand

- `assets/demo.gif` shows the Autonomous mode Kanban board.
- The existing TUI lives in `src/ui/`: board, columns, cards, detail view and contextual sidebar legend.
- There are no testimonials, user counts or benchmarks. Do not fabricate them.

## Product Principles

- Less is the feature. Every element on screen must earn its place; one state per worktree beats a stack of chips.
- The agent's terminal is the work. Lisa frames it and never competes with it.
- Never lose work silently. Destructive actions refuse by default and explain why.
- Tell the user when an agent needs them, unless they are already looking at it.
