# Activity memoization for planner calls

Extend the `cachedValue` seam of `ReviewCache.ts` to the model calls a
story makes before any code exists, so a restarted story skips its planner
calls, not only its merged tasks. The idea is `effect/workflow`'s Activity
(a named effect whose result is stored under an idempotency key and
replayed on resume), distilled onto llm4ts's file-backed state; the
runtime is not adopted (assessment of 2026-10-12). No ADR.

Driver: a story restarted after a failed gate, a usage-limit switch or a
crash plans its tasks again with the same inputs and pays for it; review
and judge calls already reuse by fingerprint (`cachedValue`,
`fingerprintOf`), gates reuse their baseline, the planner does not.

## Decisions

| Decision     | Choice                                                                                                                                                                                                                                          |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Seam         | `cachedValue` in `ReviewCache.ts` unchanged; the module keeps its name (one cache seam, CLAUDE.md), its doc comment widens to "answers persisted beside their fingerprint".                                                                     |
| Calls        | Story task planning (`defaultPlanTasks` and the perimeter re-plan in `Stories.ts`), the epic planner's story plan when `--plan-only` is rerun, and the refine-round planner (ADR 0021). Coder turns are never memoized.                         |
| Key          | `fingerprintOf` over, in order: a cache version constant, the prompt text as sent, the planner's connector id and model, the orientation digest, the carried notes, the story's acceptance criteria, the epic head commit for the story's base. |
| Path         | `stories/<id>/plan-cache.json` (and `plan-cache.json` at the epic root for the story plan), through `PlainFileStoreShape`; compacted by `--land` with the other story artifacts.                                                                |
| Reuse        | On by default when the story is restarted (`started` and not `merged`); a fresh run of a never-started story has no entry; `LLM4TS_REUSE=off` or `--no-reuse` evaluates and stores without reading.                                             |
| Event        | A reused answer publishes an `Info` ("planner answer reused, fingerprint unchanged") and a `Timed` of zero model time so `profile` and `costs` attribute nothing to it; the trace line carries `reused: true`.                                  |
| Profile      | `llm4ts profile` counts reused planner calls per story and per epic; the harness-evals delta table gains the column.                                                                                                                            |
| Invalidation | Any key part changing; no time-based expiry.                                                                                                                                                                                                    |

## Modules

- `packages/flow/src/Stories.ts`: wrap `planTasks` and the re-plan in
  `cachedValue`; build the key; publish the `Info`.
- `packages/flow/src/StoryPlan.ts` or the epic-stories lib: the story plan
  cache under `--plan-only` reruns.
- `packages/flow/src/RefineRound.ts` and the refine path in
  `flows/lib/epic-stories.ts`: the same wrap.
- `packages/runner/src/Profile.ts`: the count; `FlowArgs.ts`/`Cli.ts`: the
  flag and variable.

## Tasks

- [ ] Key builder as a pure function with a test that each listed part
      changes the fingerprint and nothing else does.
- [ ] `planTasks` memoized; a story restarted with the same inputs makes no
      planner call (fake connector counts calls); a changed acceptance
      criterion makes one.
- [ ] Epic plan and refine planner memoized the same way.
- [ ] `Info` and `Timed` on reuse; `profile` count and the delta column.
- [ ] `--no-reuse` and `LLM4TS_REUSE`; `--land` compaction.
- [ ] `docs/configuration.md`, `docs/flow-authoring.md` (the cache seam),
      CHANGELOG.

## Tests

Deterministic with `makeMemoryPlainFileStore`, the story fixtures and a
counting fake connector; replay test that `profile` reports the reused
count from a trace fixture.

## Non-goals

Memoizing coder turns, reviews across different diffs, or gates; a durable
workflow engine; cross-epic reuse; `effect/workflow` as a dependency.
