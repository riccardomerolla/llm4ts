# House rules

- One feature per folder under `src/features/<name>/`: a module and its test
  beside it. `src/app.ts` is the only composition point; exactly one story
  per epic owns it.
- Shared types and helpers live under `src/contracts/`; a feature imports a
  contract, never another feature.
- Tests use Vitest, `import { describe, expect, it } from "vitest"`, one
  `describe` per module. A skipped test is a bug to fix, not a line to keep.
- `pnpm typecheck && pnpm lint && pnpm test` must be green before a change is
  done. `src/platform/` is legacy code outside every story's scope.
