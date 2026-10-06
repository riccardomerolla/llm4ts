# Gates: baselines, failure triage, timeouts, diagnostics files

Lift the target's gates out of the epic-stories script into a `@llm4ts/flow`
module, give every gate run a baseline to compare against, triage failures
into `new`, `base` and `flaky` before any of them blocks a merge, bound each
gate with a timeout, and write gate output to files the fix round reads.
Release A of ADR 0027 (decisions 1–3).

Driver: a story inherits every red gate on the base branch as its own
failure (the rehearsals on the customer's Gemini setup restarted stories
over reds they had not caused); a hung test is a hung run; gate output is
pasted whole into the fix prompt. The Bun port's test swarm baselined every
test file against the old binary and classified failures `crash|hang|diverge`
into a `.diag` file the fixer was told was its only runtime evidence.

## Decisions (agreed 2026-10-06)

| Decision    | Choice                                                                                                                                                                                                                                                                                                                              |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Module      | `packages/flow/src/Gates.ts`: `gatesIn`, baseline cache, normalization, triage. The epic-stories lib keeps only app-dir resolution and command discovery.                                                                                                                                                                           |
| Baseline    | The gates' result on the code the story started from. Reuse the post-merge epic gate run (epic-stories) or the task checkpoint (`implementPlanFlow`); cache by base commit + gate command + app dir under the run's state folder; recompute when the base moves; a flow with no base keeps today's behaviour and publishes an Info. |
| Matching    | Generic: strip ANSI, durations, timestamps and absolute paths, compare the set of normalized failing lines. Per-tool parsers are a later pack `diagnostics:` seam.                                                                                                                                                                  |
| `new`       | Blocks; feeds the fix round; becomes the round's `ReviewResult`.                                                                                                                                                                                                                                                                    |
| `base`      | Never blocks; listed once as Info in the story findings and in the run report; growth in base failures under the story is `new`.                                                                                                                                                                                                    |
| `flaky`     | One deterministic rerun of the **test** gate only, only when it has `new` failures; a line red once and green once is `flaky`: reported, never blocking. Typecheck and lint are never rerun.                                                                                                                                        |
| Timeout     | `LLM4TS_GATE_TIMEOUT`, default 20 minutes, applied in `lintCommand`; the result carries `class: red \| hang \| crash`; a hang is a failure whose message says so. No per-gate override yet.                                                                                                                                         |
| Diag files  | Gate output to `<state>/stories/<id>/gates/<task>-<gate>.log` (or `<state>/gates/` for flat plans); the fix prompt gets a tail under `LLM4TS_GATE_TAIL_CHARS` (default 4000) plus the path for CLI coders, and the sentence "this file is your only runtime evidence; if you are guessing, say `confidence: low`".                  |
| On `--land` | Baselines deleted; gate logs compacted to their failing lines.                                                                                                                                                                                                                                                                      |
| Seam        | `ReviewIssue` gains optional `origin: "new" \| "base" \| "flaky"` and `lintCommand` results gain `class`; no parallel result type.                                                                                                                                                                                                  |

## Modules

### `packages/flow/src/Gates.ts`

- `GateCommand`, `GateResult` (`ReviewResult` + `class`, `durationMs`,
  `logPath?`), `GateBaseline` schema (`baseCommit`, `appDir`, `command`,
  `failingLines`, `passedCount?`, `recordedAt`) persisted as JSON through
  `PlainFileStoreShape`.
- `normalizeGateOutput(text): ReadonlyArray<string>` — pure; ANSI,
  durations (`12 ms`, `(1.2s)`), ISO timestamps, absolute path prefixes
  (the work dir and the app dir) removed; empty and summary-only lines
  dropped.
- `triage(current, baseline): { new, base, flaky? }` — pure set
  difference over normalized lines; `flaky` filled by the caller after a
  rerun.
- `gatesIn(process, events, commands, options)` — moved from the
  epic-stories lib; stops at the first red gate; applies the timeout;
  writes the log; returns `GateResult`s merged into a `ReviewResult` whose
  issues carry `origin`.
- `baselineFor(store, key)` / `recordBaseline(store, key, result)` and
  `baselineKey(baseCommit, appDir, commands)`.

### `packages/flow/src/Review.ts`

- `lintCommand` gains `timeout` and returns `class`; `ReviewIssue` gains
  `origin`.
- `reviewAndFixLoop`'s `lint` result is triaged when `options.baseline` is
  given: `base` issues are published as Info and removed from the blocking
  result; `flaky` rerun happens here, for the test gate only.
- `fixPrompt` renders the diag tail and path when the result carries a
  `logPath`.

### `packages/flow/src/Stories.ts` and `packages/shell/flows/lib/epic-stories.js`

- The post-merge epic gate run records the baseline for the new epic head;
  a story's first task reads it (or runs the gates once on its base when
  absent).
- Story findings and the epic report list `base` failures once, with a line
  "inherited from the base; a cleanup story may own them".
- `--land` deletes baselines and compacts gate logs.

### `packages/flow/src/Flow.ts`

- `implementPlanFlow` takes the task checkpoint commit as the base when
  `options.baseline` is on; otherwise today's behaviour.

## Tasks

- [ ] `Gates.ts` with `normalizeGateOutput`, `triage`, baseline schema and
      store helpers; pure-function tests with recorded vitest, tsc and
      eslint outputs as fixtures.
- [ ] Move `gatesIn` into `Gates.ts`; the epic-stories lib imports it;
      existing tests unchanged.
- [ ] `lintCommand` timeout and `class`; a fake process that never exits
      proves `hang`.
- [ ] Gate logs written to the state folder; `fixPrompt` renders tail plus
      path; `LLM4TS_GATE_TAIL_CHARS` honoured; API coders get the tail only.
- [ ] `reviewAndFixLoop` triage with `options.baseline`; `base` published as
      Info and non-blocking; growth counted as `new`; flaky rerun for the
      test gate only.
- [ ] epic-stories records the baseline after every epic gate run and reads
      it per story; `implementPlanFlow` uses the checkpoint commit.
- [ ] Report and findings list inherited reds once; `--land` cleanup.
- [ ] `docs/configuration.md` (two new variables), `docs/flow-authoring.md`
      "Per-task gates" updated, `docs/parity.md` divergence note, CHANGELOG.

## Tests

Deterministic with the in-src fakes: a fixture repo whose base has one red
test lets a story that does not touch it merge and lists the red as
inherited; a story that breaks a second test is blocked on that one only; a
test gate red once and green on rerun is `flaky` and does not block; a gate
whose process never exits ends as `hang` within the fake clock's timeout.

## Non-goals

Per-tool parsers; per-gate timeout overrides; baselines across runs or
epics; any change to which gates run.
