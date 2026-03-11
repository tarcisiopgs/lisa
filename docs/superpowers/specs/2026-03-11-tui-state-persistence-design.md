# TUI State Persistence Design

**Date:** 2026-03-11
**Status:** Approved
**Branch:** feat/tui-state-persistence

## Problem

The Lisa TUI Kanban board is entirely in-memory. When the user kills the process and restarts, the board starts empty. All context about what was completed, what failed, and what is pending is lost until the loop re-fetches and re-emits events.

## Goal

Persist Kanban card state across process restarts so that completed work remains visible in the "Done" column and pending work reappears in "Backlog" without waiting for a full refetch cycle.

## Behavioral Rules

- **Done cards** remain in "Done" across restarts.
- **Backlog cards** remain in "Backlog" across restarts.
- **In-progress cards at the time of kill:**
  - If `prUrls.length > 0` → promoted to "Done" on next load.
  - If `prUrls.length === 0` → demoted to "Backlog", `startedAt` cleared, `hasError`/`killed`/`skipped` all reset to `false` (the process was interrupted, not errored).
- **State never auto-clears.** Accumulates indefinitely across all runs on the same project. Manual cleanup only (by deleting `kanban-state.json`). No eviction policy — this is intentional; the Done column is a historical record.
- **Output log:** only the last 100 lines are persisted. Full in-memory log is reconstructed from tail on hydration.
- **Merge polling:** when hydrating Done cards with `prUrls.length > 0` and `merged !== true`, merge polling is restarted in `useKanbanState` so the merged badge stays live.
- **TUI-only:** `KanbanPersistence` is only instantiated when TUI mode is active. Headless runs do not write or read `kanban-state.json`.

## Architecture

```
kanbanEmitter (events)
       │
       ▼
KanbanPersistence          (session/kanban-persistence.ts)
  - listens to all relevant kanbanEmitter events
  - maintains serialized state in memory
  - debounced writes to kanban-state.json (500ms)
  - resolves in_progress → backlog/done on load()
       │
       ▼
kanban-state.json          (getCacheDir(cwd)/kanban-state.json)
       │
       ▼
useKanbanState (React)
  - on mount: receives initialCards hydrated from kanban-state.json
  - continues listening to events normally (existing behavior unchanged)
```

## Data Model

```ts
interface PersistedKanbanState {
  version: 1;
  cards: PersistedCard[];
  updatedAt: number;
}

interface PersistedCard {
  id: string;
  title: string;
  column: "backlog" | "in_progress" | "done";
  startedAt?: number;
  finishedAt?: number;
  prUrls: string[];
  hasError?: boolean;
  skipped?: boolean;
  killed?: boolean;
  merged?: boolean;
  logFile?: string;
  outputLogTail: string[]; // last 100 lines
}
```

**Not persisted (ephemeral):** `pausedAt`, `pauseAccumulated`, full `outputLog`.

## Implementation

### `session/kanban-persistence.ts`

The argument passed to `createKanbanPersistence` is `workspace` (i.e., `resolve(config.workspace)`), not `process.cwd()`, to ensure all artifacts land in the same cache bucket as `guardrails.md`, manifests, and other loop artifacts.

```ts
class KanbanPersistence {
  private state: PersistedKanbanState;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly statePath: string;
  private readonly OUTPUT_TAIL_LINES = 100;

  constructor(workspace: string) { ... }

  load(): KanbanCard[]       // reads file, resolves in_progress, returns hydrated cards
  start(): void              // registers kanbanEmitter listeners
  stop(): void               // cancels timer, synchronous final flush

  private scheduleFlush(): void   // debounce 500ms → flush
  private flush(): void           // writeFileSync to statePath
  private upsertCard(...): void   // create if not exists
  private updateCard(...): void   // partial merge
  private appendOutput(...): void // maintains last N lines tail
}

export function createKanbanPersistence(workspace: string): KanbanPersistence
```

**Error handling in `load()`:**
- File does not exist → return `[]` (first run).
- File exists but fails to parse (corrupted, partial write from crash) → log warning to stderr, rename file to `kanban-state.json.bak`, return `[]`.
- File has `version !== 1` → silently discard, return `[]`.

**`in_progress` resolution in `load()`:**
- `prUrls.length > 0` → set `column: "done"`.
- `prUrls.length === 0` → set `column: "backlog"`, clear `startedAt`, reset `hasError`/`killed`/`skipped` to `false`.

### Event → Action mapping

| Event | Action |
|---|---|
| `issue:queued` | upsert card in `backlog` |
| `issue:started` | move to `in_progress`, set `startedAt` |
| `issue:done` | move to `done`, set `prUrls`, `finishedAt` |
| `issue:merged` | set `merged: true` |
| `issue:reverted` | move to `backlog`, set `hasError: true` |
| `issue:skipped` | move to `backlog`, set `skipped: true` |
| `issue:killed` | move to `backlog`, set `killed: true` |
| `issue:log-file` | set `logFile` |
| `issue:output` | append to output tail, schedule flush |

### `paths.ts`

Add:
```ts
export function getKanbanStatePath(cwd: string): string {
  return join(getCacheDir(cwd), "kanban-state.json");
}
```

### `loop/index.ts`

Only executed when TUI mode is active:

```
1. ensureCacheDir(workspace)
2. persistence = createKanbanPersistence(workspace)
3. initialCards = persistence.load()   // synchronous, resolves in_progress
4. persistence.start()                 // begin listening to events
5. render(<KanbanApp initialCards={initialCards} />)
```

**Shutdown:** `persistence.stop()` is called in `signals.ts` (or the loop's SIGINT handler in `loop/index.ts`) **directly before `process.exit(0)`**, not inside any React component lifecycle. This guarantees the synchronous `writeFileSync` in `stop()` executes before the process exits, regardless of the 250ms Ink cleanup window.

### `useKanbanState`

Add `initialCards: KanbanCard[] = []` parameter:

```ts
export function useKanbanState(
  bellEnabled: boolean,
  initialCards: KanbanCard[] = [],
): KanbanStateData {
  const [cards, setCards] = useState<KanbanCard[]>(initialCards);
  // ... rest unchanged
}
```

`outputLog` for each hydrated card is reconstructed as `card.outputLogTail.join("\n")` during the `PersistedCard → KanbanCard` conversion in `load()`.

**Merge polling on hydration:** after seeding `initialCards`, the `useEffect` that runs on mount iterates hydrated cards with `column === "done"`, `prUrls.length > 0`, and `merged !== true`, and calls `startMergePolling` for each. This ensures the merged badge updates correctly for PRs that were opened before the last restart.

### Deduplication

The existing `onQueued` guard (`if (prev.some((c) => c.id === issue.id)) return prev`) already prevents duplicates when the loop re-emits `issue:queued` for cards already loaded from the persisted state. No changes needed.

### Shutdown flush

`persistence.stop()` is called in the `tui:exit` / SIGINT handler to perform a synchronous final flush before the process exits.

## Files Changed

| File | Change |
|---|---|
| `src/paths.ts` | Add `getKanbanStatePath()` |
| `src/session/kanban-persistence.ts` | New file |
| `src/session/kanban-persistence.test.ts` | New file |
| `src/ui/state.ts` | Add `initialCards` param to `useKanbanState` |
| `src/ui/kanban.tsx` | Pass `initialCards` prop through to `useKanbanState` |
| `src/loop/index.ts` | Instantiate persistence, load initial cards, pass to TUI, stop on shutdown |

## Testing

- Unit tests for `KanbanPersistence`: load with empty file, load with existing state, in_progress resolution (with/without prUrls), event handlers, debounced flush, output tail capping, stop flushes synchronously.
- Unit tests for `useKanbanState`: verify `initialCards` seeds state correctly, deduplication with queued events.
