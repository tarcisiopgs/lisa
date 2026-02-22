# Model-Level Fallback Design

## Goal

Separate `provider` (the executor binary) from `models` (which AI models to use within that provider). The first model is primary; the rest are fallbacks in order. Cross-provider fallback is removed.

## Config Schema

```yaml
# New format
provider: claude
models:
  - claude-opus-4-5
  - claude-sonnet-4-5
  - claude-haiku-4-5

# Backward compat — no models → provider uses its own default
provider: gemini
```

- `provider`: single ProviderName, the executor binary
- `models`: ordered list of model name strings for that provider
- If `models` is absent or empty → resolved as `[{ provider }]` (no model flag passed)

## Internal Types

```ts
// types.ts
export interface ModelSpec {
  provider: ProviderName;
  model?: string; // undefined = use provider's default
}

export interface RunOptions {
  // ...existing fields...
  model?: string; // passed down from ModelSpec
}
```

## Resolution

`resolveModels(config)` in `config.ts`:

```
provider: claude, models: [opus, sonnet]
→ [{ provider: "claude", model: "opus" }, { provider: "claude", model: "sonnet" }]

provider: gemini, models: []
→ [{ provider: "gemini" }]
```

Backward compat rule:
- If a model name equals the provider name (e.g. `models: [claude]`) → treat as `{ provider, model: undefined }` (no model flag, same as omitting models)

`runWithFallback` changes signature from `models: ProviderName[]` to `models: ModelSpec[]`. Each iteration passes `spec.model` via `RunOptions`.

## Provider Changes

Each provider reads `opts.model` and appends the flag when present:

```ts
// claude.ts
const modelFlag = opts.model ? `--model ${opts.model}` : "";
// gemini.ts
const modelFlag = opts.model ? `--model ${opts.model}` : "";
// copilot.ts, cursor.ts — ignore opts.model (CLI doesn't expose --model)
// opencode.ts — check opencode CLI for --model support
```

## Init Wizard

After provider selection, show model picker (multi-select, hardcoded top models per provider):

```
? Which models? (first = primary, rest = fallbacks)
  ◉ claude-opus-4-5
  ◉ claude-sonnet-4-5
  ◯ claude-haiku-4-5
```

Skip = no `models` in config → uses provider default.

## What Changes

- `types.ts`: add `ModelSpec`, add `model?: string` to `RunOptions`
- `config.ts`: add `resolveModels()`, update `Config` type (`models: string[]`)
- `providers/index.ts`: `runWithFallback` takes `ModelSpec[]`
- `loop.ts`: call `resolveModels(config)` and pass result to `runWithFallback`
- `providers/claude.ts`, `gemini.ts`: read `opts.model`, append `--model` flag
- `cli.ts`: update `init` wizard with model selection step
- Remove cross-provider fallback (was driven by `models: ProviderName[]` in config)
