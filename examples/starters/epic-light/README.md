# epic-light

A ten-file TypeScript repository for comparing two llm4ts releases on the same
three-story epic in minutes rather than hours. Two feature folders, one shared
contract to add, one composition point, and three things planted on purpose:

- `src/platform/clock.test.ts` is red on `main` and no story owns it: the gate
  triage must list it as inherited, never charge a story with it.
- `src/features/counter/counter.test.ts` skips one test: the `counter-history`
  story's acceptance says to restore it.
- `counter-history` cannot meet its acceptance without changing an existing
  test's expectation, so its plan entry declares `testsChange: true`.

Gates: `pnpm typecheck`, `pnpm lint`, `pnpm test`. Seeded by
`examples/seed.sh epic`, which also drops the fixed plan at
`.llm4ts/epics/epic-light/plan.md` so no planner call is needed.
