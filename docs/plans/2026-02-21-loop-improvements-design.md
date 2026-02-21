# Loop Improvements Design

Three improvements to Lisa's main loop: native Claude Code worktree support, pre-agent multi-repo planning, and PR description formatting.

## 1. Native Claude Code `--worktree` Support

Claude Code 2.1.50+ supports `--worktree`, which creates and manages its own git worktree internally. Lisa should delegate worktree lifecycle to Claude Code when available, while keeping manual worktree management for providers that don't support it (Gemini, OpenCode).

### Interface Changes

`Provider` gains an optional `supportsNativeWorktree?: boolean` property. `RunOptions` gains `useNativeWorktree?: boolean` so providers know when to add the flag.

### Provider Changes

`ClaudeProvider` sets `supportsNativeWorktree = true`. When `opts.useNativeWorktree` is true, the spawn command becomes:

```
claude -p --dangerously-skip-permissions --worktree "$(cat 'file')"
```

### Loop Changes

In `runWorktreeSession()`, before the provider runs:

- **Provider supports native worktree**: Skip `createWorktree()`. Pass the repo root as `cwd` with `useNativeWorktree: true`. After the run, read the manifest from the repo root. Lisa still handles push + PR creation from the branch reported in the manifest. Skip `removeWorktree()` cleanup (Claude Code handles it).
- **Provider does NOT support native worktree**: Existing flow unchanged — Lisa pre-creates the worktree, sets `cwd` to the worktree path, handles cleanup.

The `providers/index.ts` factory must expose the provider instance (not just the `FallbackResult`) so the loop can check `supportsNativeWorktree` before deciding the worktree strategy.

### Prompt Changes

A new `buildNativeWorktreePrompt()` template is needed because the agent is NOT already on a branch — Claude Code's `--worktree` creates the worktree internally. The prompt tells the agent to work normally (it's in a worktree), commit, and write the manifest with the branch name. The existing `buildWorktreePrompt()` stays for non-native providers where Lisa pre-creates the worktree.

### Files Touched

- `types.ts` — Add `useNativeWorktree?: boolean` to `RunOptions`, `supportsNativeWorktree?: boolean` to `Provider`
- `providers/claude.ts` — Set flag, conditionally add `--worktree`
- `providers/index.ts` — Expose provider instance alongside `FallbackResult`
- `loop.ts` — Conditional worktree creation in `runWorktreeSession()`
- `prompt.ts` — Add `buildNativeWorktreePrompt()`

## 2. Pre-Agent Multi-Repo Analysis

When `config.repos.length > 1`, a planning phase runs before implementation. Lisa spawns the same provider with a planning-only prompt that analyzes the issue and outputs a structured execution plan. Single-repo configs skip this entirely.

### New Flow

```
fetch issue
  → planning phase (provider analyzes issue, outputs .lisa-plan.json)
  → for each step in plan (sequential):
      → single-repo worktree session (reuses runWorktreeSession)
      → push → PR
  → done
```

### Planning Phase

1. Lisa builds `buildPlanningPrompt(issue, config)` with the issue description and all available repos
2. The provider writes `.lisa-plan.json` to the workspace:
   ```json
   {
     "steps": [
       { "repoPath": "/abs/path/to/api", "scope": "Add new endpoint for X", "order": 1 },
       { "repoPath": "/abs/path/to/web", "scope": "Add UI component consuming X", "order": 2 }
     ]
   }
   ```
3. Lisa reads and validates the plan (all repos exist in config, no duplicates)
4. If plan has 1 repo: run a normal single-repo worktree session
5. If plan has N repos: run N sequential single-repo sessions

### Scoped Implementation

Each repo session gets a `buildScopedImplementPrompt(issue, step, previousResults)` that includes:
- The original issue description
- The plan step's scope (what to do in this specific repo)
- Context from previous repos (PR URLs, branch names) so the agent knows what was already done

### What It Replaces

`runWorktreeMultiRepoSession()` is replaced. Instead of giving the agent all repos and letting it pick one, Lisa drives the sequencing — it picks the repo (based on the plan), creates the worktree (or delegates via `--worktree` for Claude), and runs the agent scoped to that single repo.

Each step reuses `runWorktreeSession()`, which means native worktree support (feature 1) applies automatically to each repo step.

### Fully Autonomous

No human review/approval pause. The planning phase runs, Lisa reads the plan, and execution proceeds immediately.

### Files Touched

- `prompt.ts` — Add `buildPlanningPrompt()`, `buildScopedImplementPrompt()`
- `loop.ts` — Replace `runWorktreeMultiRepoSession()` with planning + sequential single-repo sessions
- `types.ts` — Add `PlanStep` and `ExecutionPlan` interfaces

## 3. PR Description Formatting

PR descriptions from the agent's `.lisa-manifest.json` are often poorly formatted. Fix at the source (better prompts) and add a safety net (post-processing).

### Prompt Improvements

Replace the vague "use bullet points and optionally bold" instruction in all prompt templates with a concrete example:

```markdown
The `prBody` MUST follow this exact markdown structure:

- **What**: one-line summary of the change
- **Why**: motivation or issue context
- **Key changes**:
  - `src/foo.ts` — added X functionality
  - `src/bar.ts` — refactored Y to support Z
- **Testing**: what was validated (e.g. "all unit tests pass", "manually tested endpoint")
```

This applies to `buildWorktreePrompt`, `buildBranchPrompt`, `buildNativeWorktreePrompt`, and `buildScopedImplementPrompt`.

### Post-Processing in `buildPrBody()`

After reading the manifest's `prBody`, apply lightweight cleanup:

1. Trim leading/trailing whitespace and blank lines
2. If the description has no newlines (wall of text), split on sentence boundaries and convert to bullet points
3. Strip raw HTML `<tags>` that could break GitHub rendering
4. Normalize bullet style — convert `*` bullets to `-` for consistency

Pure string manipulation — no AI call, no external dependency.

### Files Touched

- `prompt.ts` — Replace vague prBody instructions with concrete template in all prompt builders
- `loop.ts` — Enhance `buildPrBody()` with post-processing cleanup
