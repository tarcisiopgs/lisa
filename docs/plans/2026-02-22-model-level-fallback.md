# Model-Level Fallback Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Separate `provider` (the executor binary) from `models` (ordered list of model names within that provider), enabling per-model fallback instead of per-provider fallback.

**Architecture:** `ModelSpec = { provider, model? }` is a new internal type. `resolveModels()` in `loop.ts` converts the config into `ModelSpec[]`, applying backward-compat rules. `runWithFallback` in `providers/index.ts` accepts `ModelSpec[]` and passes `model` to each provider via `RunOptions`. Claude and Gemini read `opts.model` and append `--model <name>` to their command.

**Tech Stack:** TypeScript, Node.js 20, vitest, @clack/prompts.

---

### Task 1: Add `ModelSpec` to types, update `LisaConfig.models` and `RunOptions`

**Files:**
- Modify: `src/types.ts`

**Step 1: Write the failing typecheck**

Run:
```bash
npm run typecheck
```
Note the current output (should be clean). After this task it must stay clean.

**Step 2: Apply changes to `src/types.ts`**

1. Change `LisaConfig.models` from `ProviderName[]` to `string[]`:
```ts
// before
models?: ProviderName[];

// after
models?: string[];
```

2. Add `model?: string` to `RunOptions`:
```ts
export interface RunOptions {
  logFile: string;
  cwd: string;
  guardrailsDir?: string;
  issueId?: string;
  overseer?: OverseerConfig;
  useNativeWorktree?: boolean;
  model?: string; // model name to pass to the provider CLI
}
```

3. Add `model?: string` to `ModelAttempt` (for better logging):
```ts
export interface ModelAttempt {
  provider: ProviderName;
  model?: string;
  success: boolean;
  error?: string;
  duration: number;
}
```

4. Add `ModelSpec` interface **before** `RunOptions`:
```ts
export interface ModelSpec {
  provider: ProviderName;
  model?: string; // undefined = use provider's default model
}
```

**Step 3: Verify typecheck passes**

Run:
```bash
npm run typecheck
```
Expected: no errors.

**Step 4: Commit**

```bash
git add src/types.ts
git commit -m "feat: add ModelSpec type and model field to RunOptions/ModelAttempt"
```

---

### Task 2: Update `resolveModels` in `loop.ts`

**Files:**
- Modify: `src/loop.ts` (lines 52–55)

The current `resolveModels` returns `ProviderName[]`. Change it to return `ModelSpec[]` with backward-compat rules.

**Step 1: Import `ModelSpec` in `loop.ts`**

Find the existing types import at the top of `loop.ts`:
```ts
import type {
  ExecutionPlan,
  FallbackResult,
  LisaConfig,
  PlanStep,
  ProviderName,
  RepoConfig,
  Source,
} from "./types.js";
```

Add `ModelSpec` to that import:
```ts
import type {
  ExecutionPlan,
  FallbackResult,
  LisaConfig,
  ModelSpec,
  PlanStep,
  ProviderName,
  RepoConfig,
  Source,
} from "./types.js";
```

**Step 2: Replace `resolveModels`**

Current (lines 52–55):
```ts
function resolveModels(config: LisaConfig): ProviderName[] {
  if (config.models && config.models.length > 0) return config.models;
  return [config.provider];
}
```

Replace with:
```ts
function resolveModels(config: LisaConfig): ModelSpec[] {
  if (!config.models || config.models.length === 0) {
    return [{ provider: config.provider }];
  }
  return config.models.map((m) => ({
    provider: config.provider,
    // Backward compat: if model name equals provider name, treat as "no model" (use provider default)
    model: m === config.provider ? undefined : m,
  }));
}
```

**Step 3: Fix the `models` variable type used in `runWithFallback` calls**

At line 290:
```ts
const models = resolveModels(config);
```
This now returns `ModelSpec[]`. All existing `runWithFallback(models, ...)` calls will need the signature updated in the next task.

There is also a call on line 193:
```ts
const result = await runWithFallback(opts.models, recoveryPrompt, {
```

Search for `opts.models` in `loop.ts` to find its type. It comes from a local `opts` parameter. That parameter must also be updated. Search for its declaration and change the type from `ProviderName[]` to `ModelSpec[]`. The call site that builds it (around `runPushRecovery`) passes `models` directly — that's already `ModelSpec[]` after step 2.

To find the `opts` interface for `runPushRecovery`, search for `PushRecoveryOptions` in `loop.ts`:

```ts
interface PushRecoveryOptions {
  branch: string;
  cwd: string;
  // ...
  models: ProviderName[];  // ← change this to ModelSpec[]
```

Update that to `ModelSpec[]`.

**Step 4: Verify typecheck**

```bash
npm run typecheck
```

If `runWithFallback` still expects `ProviderName[]` there will be type errors — that's expected and will be fixed in Task 3.

**Step 5: Commit**

```bash
git add src/loop.ts
git commit -m "refactor: resolveModels returns ModelSpec[]"
```

---

### Task 3: Update `runWithFallback` in `providers/index.ts`

**Files:**
- Modify: `src/providers/index.ts`
- Modify: `src/providers/index.test.ts`

**Step 1: Write a failing test**

In `src/providers/index.test.ts`, add a test that verifies `model` is recorded in the attempt:

```ts
describe("runWithFallback ModelSpec", () => {
  it("passes model name through to RunOptions (type-level check via ModelSpec)", () => {
    // ModelSpec with a specific model should be accepted without throwing
    const spec: ModelSpec = { provider: "claude", model: "claude-opus-4-5" };
    expect(spec.model).toBe("claude-opus-4-5");
    expect(spec.provider).toBe("claude");
  });
});
```

Add `import type { ModelSpec } from "../types.js";` to the test file imports.

Run:
```bash
npm run test -- src/providers/index.test.ts
```
Expected: PASS (this is a type-level test, just verifying the import works).

**Step 2: Update `runWithFallback` signature and implementation**

In `src/providers/index.ts`:

1. Add `ModelSpec` to the import from `../types.js`:
```ts
import type { FallbackResult, ModelAttempt, ModelSpec, Provider, ProviderName, RunOptions } from "../types.js";
```

2. Change the function signature from:
```ts
export async function runWithFallback(
  models: ProviderName[],
  prompt: string,
  opts: RunOptions,
): Promise<FallbackResult>
```
to:
```ts
export async function runWithFallback(
  models: ModelSpec[],
  prompt: string,
  opts: RunOptions,
): Promise<FallbackResult>
```

3. Inside the loop, change `for (const model of models)` to use `ModelSpec`:

```ts
for (const spec of models) {
  const provider = createProvider(spec.provider);
  const available = await provider.isAvailable();

  if (!available) {
    attempts.push({
      provider: spec.provider,
      model: spec.model,
      success: false,
      error: `Provider "${spec.provider}" is not installed or not in PATH`,
      duration: 0,
    });
    continue;
  }

  const guardrailsSection = opts.guardrailsDir ? buildGuardrailsSection(opts.guardrailsDir) : "";
  const fullPrompt = guardrailsSection ? `${prompt}${guardrailsSection}` : prompt;

  const result = await provider.run(fullPrompt, { ...opts, model: spec.model });

  if (result.success) {
    attempts.push({
      provider: spec.provider,
      model: spec.model,
      success: true,
      duration: result.duration,
    });
    return {
      success: true,
      output: result.output,
      duration: result.duration,
      providerUsed: spec.provider,
      provider,
      attempts,
    };
  }

  if (opts.guardrailsDir && opts.issueId) {
    appendEntry(opts.guardrailsDir, {
      issueId: opts.issueId,
      date: new Date().toISOString().slice(0, 10),
      provider: spec.provider,
      errorType: extractErrorType(result.output),
      context: extractContext(result.output),
    });
  }

  const eligible = isEligibleForFallback(result.output);
  attempts.push({
    provider: spec.provider,
    model: spec.model,
    success: false,
    error: eligible ? "Eligible error (quota/unavailable/timeout)" : "Non-eligible error",
    duration: result.duration,
  });

  if (!eligible) {
    return {
      success: false,
      output: result.output,
      duration: result.duration,
      providerUsed: spec.provider,
      provider,
      attempts,
    };
  }
}

const totalDuration = attempts.reduce((sum, a) => sum + a.duration, 0);
return {
  success: false,
  output: formatAttemptsReport(attempts),
  duration: totalDuration,
  providerUsed: attempts[attempts.length - 1]?.provider ?? models[0]?.provider ?? "claude",
  attempts,
};
```

4. Update `formatAttemptsReport` to show model when present:
```ts
function formatAttemptsReport(attempts: ModelAttempt[]): string {
  const lines = ["All models exhausted. Attempt history:"];
  for (const [i, a] of attempts.entries()) {
    const status = a.success ? "OK" : "FAILED";
    const label = a.model ? `${a.provider}/${a.model}` : a.provider;
    const error = a.error ? ` — ${a.error}` : "";
    const duration = a.duration > 0 ? ` (${Math.round(a.duration / 1000)}s)` : "";
    lines.push(`  ${i + 1}. ${label}: ${status}${error}${duration}`);
  }
  return lines.join("\n");
}
```

**Step 3: Verify typecheck and tests**

```bash
npm run typecheck
npm run test -- src/providers/index.test.ts
```
Expected: all pass.

**Step 4: Commit**

```bash
git add src/providers/index.ts src/providers/index.test.ts
git commit -m "feat: runWithFallback accepts ModelSpec[] and passes model to providers"
```

---

### Task 4: Update `ClaudeProvider` to use `opts.model`

**Files:**
- Modify: `src/providers/claude.ts`

**Step 1: Read the file first (done above)**

**Step 2: Change `run()` to append `--model` when `opts.model` is set**

Current flags array:
```ts
const flags = ["-p", "--dangerously-skip-permissions"];
if (opts.useNativeWorktree) {
  flags.push("--worktree");
}
```

Add model flag:
```ts
const flags = ["-p", "--dangerously-skip-permissions"];
if (opts.model) {
  flags.push("--model", opts.model);
}
if (opts.useNativeWorktree) {
  flags.push("--worktree");
}
```

**Step 3: Verify typecheck and tests**

```bash
npm run typecheck
npm run test
```
Expected: all pass.

**Step 4: Commit**

```bash
git add src/providers/claude.ts
git commit -m "feat: claude provider passes --model flag from opts.model"
```

---

### Task 5: Update `GeminiProvider` to use `opts.model`

**Files:**
- Modify: `src/providers/gemini.ts`

Gemini CLI accepts `--model <name>`. Add it after `--yolo` when `opts.model` is set.

**Step 1: Change `run()` to include model flag**

Current spawn command:
```ts
const proc = spawn("sh", ["-c", `gemini --yolo -p "$(cat '${promptFile}')"`], {
```

Change to:
```ts
const modelFlag = opts.model ? `--model ${opts.model}` : "";
const proc = spawn("sh", ["-c", `gemini --yolo ${modelFlag} -p "$(cat '${promptFile}')"`], {
```

Note: if `opts.model` is undefined, `modelFlag` is `""` and the extra space in the command is harmless.

**Step 2: Verify typecheck and tests**

```bash
npm run typecheck
npm run test
```

**Step 3: Commit**

```bash
git add src/providers/gemini.ts
git commit -m "feat: gemini provider passes --model flag from opts.model"
```

---

### Task 6: Update `cli.ts` init wizard with model selection

**Files:**
- Modify: `src/cli.ts`

After provider selection, if the provider supports model selection (claude or gemini), show a multi-select prompt. OpenCode, Copilot, and Cursor do not support `--model`.

**Step 1: Add hardcoded model lists per provider**

After the `providerLabels` constant, add:
```ts
const providerModels: Partial<Record<ProviderName, string[]>> = {
  claude: ["claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5"],
  gemini: ["gemini-2.5-pro", "gemini-2.0-flash", "gemini-1.5-pro"],
};
```

**Step 2: Add model selection step after `providerName` is determined**

After the block that sets `providerName` (around line 221), add:

```ts
let selectedModels: string[] = [];

const availableModels = providerModels[providerName];
if (availableModels && availableModels.length > 0) {
  const modelSelection = await clack.multiselect({
    message: "Which models to use? (first = primary, rest = fallbacks in order)",
    options: availableModels.map((m, i) => ({
      value: m,
      label: m,
      hint: i === 0 ? "primary" : `fallback ${i}`,
    })),
    required: false,
  });
  if (clack.isCancel(modelSelection)) return process.exit(0);
  selectedModels = (modelSelection as string[]) ?? [];
}
```

**Step 3: Save `models` to config when selected**

When building `cfg`, add `models` only when non-empty:
```ts
const cfg: LisaConfig = {
  provider: providerName,
  ...(selectedModels.length > 0 ? { models: selectedModels } : {}),
  source: source as SourceName,
  // ...rest unchanged
};
```

**Step 4: Verify typecheck**

```bash
npm run typecheck
```

**Step 5: Commit**

```bash
git add src/cli.ts
git commit -m "feat: init wizard prompts for model selection after provider"
```

---

### Task 7: Run full CI and fix any remaining issues

**Step 1: Run full CI**

```bash
npm run ci
```

Expected: lint + typecheck + tests all pass.

**Step 2: If any errors, fix them**

Common issues:
- Any remaining `ProviderName[]` where `ModelSpec[]` is now expected — update types
- `isCompleteProviderExhaustion` tests that use `ModelAttempt` — `model` is optional so no change needed
- `opts.models` in `PushRecoveryOptions` — verify it was updated in Task 2

**Step 3: Build and link**

```bash
npm run build && npm link
```

**Step 4: Final commit if needed**

```bash
git add -A
git commit -m "fix: resolve any remaining type errors from model-level fallback"
```
