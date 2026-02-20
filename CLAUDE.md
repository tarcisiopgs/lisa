# Lisa — Project Conventions

## Language

- All code, comments, and documentation must be written in English.
- All git commit messages must be in English using conventional commits format (`feat:`, `fix:`, `refactor:`, `chore:`).
- All PR titles must be in English using conventional commits format.
- All PR descriptions must be in English.
- Issue descriptions may be in any language — read them for context but produce all artifacts in English.

## PR Title Convention

PR titles follow the conventional commits format:

```
feat: add dependency-based issue execution
fix: recover interrupted sessions
refactor: extract worktree logic into module
chore: update biome config
```

## Stack

- TypeScript (strict mode)
- Node.js (ESM)
- Biome (linting + formatting)
- Vitest (testing)
- tsup (bundling)

## Validation

Before committing, run:

```bash
npm run lint
npm run typecheck
npm run test
```
