# Stall detection: stopping conditions the model does not control

End a task with a typed `Stalled` failure when two consecutive review
rounds see a byte-identical diff, or when the same tool call with the same
arguments repeats five times in a row; an optional silence timer. Release B
of ADR 0027 (decision 11).

Driver: Anthropic's guidance bounds agent loops with conditions the model
cannot talk its way past (turn and budget caps, stall detection); the
C-compiler write-up notes agents "can't tell time" and loop on tests. llm4ts
has budgets and (for Gemini) turn limits, but a coder that re-edits the same
line each round or re-runs the same grep is only noticed by a person
watching `llm4ts watch`.

## Decisions (agreed 2026-10-06)

| Decision    | Choice                                                                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signal 1    | Two consecutive review rounds over a byte-identical diff (after `format`), detected in `reviewAndFixLoop`. On by default.                                                             |
| Signal 2    | The same tool name with the same normalized `args` `LLM4TS_STALL_REPEATS` times in a row (default 5), detected from the transcript stream in the runner. On by default.               |
| Signal 3    | No transcript entry for `LLM4TS_STALL_MINUTES`; unset means off. Off by default because long thinking on a slow seat looks like silence.                                              |
| Outcome     | Typed `Stalled { signal, detail }` in `FlowError`; the task fails, the story fails with the reason, dependents hold (ADR 0013), the retro digest shows the signal.                    |
| Interaction | A stall ends the current coder call through the seat's interruption path (the same one `turnLimit` and `CostBudget` use), never by killing the process outside the connector's scope. |

## Modules

- `packages/flow/src/FlowError.ts`: `Stalled`.
- `packages/flow/src/Review.ts`: diff hash per round; identical hash twice
  → `Stalled("identical-diff")`.
- `packages/flow/src/Stall.ts`: pure `repeatDetector(limit)` over
  `TranscriptEntry` `Tool` lines; `silenceDetector(minutes, clock)`.
- `packages/runner/src/FlowRunner.ts` (transcript consumer): feeds the
  detectors and interrupts the seat call with `Stalled`.
- `packages/flow/src/Retro.ts`: the digest renders the stall signal and the
  last repeated call.

## Tasks

- [ ] `Stalled` error and the two pure detectors with tests (fake clock).
- [ ] `reviewAndFixLoop` identical-diff detection; test with a fake coder
      that never changes the tree.
- [ ] Runner wiring through the transcript consumer and seat interruption;
      test with a fake connector emitting the same tool call six times.
- [ ] Retro digest line; `llm4ts watch` shows the stall reason.
- [ ] Docs: `docs/configuration.md` (two variables), CHANGELOG.

## Tests

A coder whose diff is identical across two rounds ends the task `Stalled`
after round two, not three; six identical `grep` calls end the call; five
do not; a silence of 30 fake minutes with `LLM4TS_STALL_MINUTES=20` ends it
and with the variable unset does not.

## Non-goals

Turn caps for CLIs that lack them (`specs/pending/cli-turn-limit-enforcement.md`);
judging progress semantically; automatic retry after a stall.
