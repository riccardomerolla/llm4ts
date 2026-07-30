# Modernize Flow Suite: the target-side phases

Complete the port of `llm4zio`'s `modernize-*.sc` example suite (pinned
v4.2.0, `examples/`) as llm4ts flows. `flows/modernize-survey.ts` and
`flows/modernize-extract.ts` — the two phases rooted at the legacy
repository — already exist; this spec covers the remaining phases, which run
rooted at the TARGET repository behind the clean-room wall, plus the
measurement flow and the fidelity gaps the first two ports deliberately
deferred (recorded in `docs/parity.md`).

## What and why

- `flows/modernize-seed.ts` — after the spec pack is approved
  (`requireApproval` on `docs/modernization/README.md`), seed the target
  repository: copy ONLY the spec pack across the clean-room wall (specs,
  features, plan, rules.txt — never legacy source), scaffold the target
  skeleton from the pack's scaffold prompt, and record provenance
  (the pinned pack, seats, and spec-pack commit).
- `flows/modernize-implement.ts` — implement the plan tasks in the target
  repo per program: fresh chat per task, review/fix rounds behind the pack's
  gates (`pack.gate("lint")` etc.), one commit per task — the
  `implementPlanFlow`/`implementTaskLoop` spine with pack-supplied prompts.
- `flows/modernize-verify.ts` — behavioural equivalence: generate vectors
  per program from the specs (`generateVectorsResumably`), replay them
  against the target (`replayEquivVector`, pack `replay:` command,
  comparison policy from the pack's `## Equivalence` section), and report
  rule coverage against `rules.txt` — the target side never re-enumerates
  the rule universe (clean-room wall).
- `flows/modernize-review.ts` — the pack's reviewer lenses (`pack.lenses`)
  over the target diff plus a summary report; append durable lessons to the
  pack (`appendPackLesson`).
- `flows/modernize-bench.ts` — measure a phase run (tokens, duration, cost)
  into `bench-results.jsonl` via `@llm4ts/flow/Bench`, and surface
  `BenchReport.render(records, projectPrograms)`; then restore the survey's
  per-wave cost projection (the survey flow currently ships without it).

## Deferred fidelity gaps to restore (from the survey/extract ports)

- [ ] Extraction gate verdict caching: per-program `gate/<NAME>.json` via
      `@llm4ts/flow/ReviewCache`, fingerprinted over source + spec +
      feature + rubric, so unchanged programs skip their judge call.
- [ ] Judge shrinking-context ladder: an empty structured response retries
      at half, then quarter context before failing.
- [ ] Pattern cards: deterministic tagging of traceability fragments with
      matched pattern cards, injected into implement briefs (needs a
      `Patterns` port — check `docs/csp/` for its contract first).
- [ ] Turn-limit recovery on analyst/fix turns: a turn-limit trip after the
      artifact landed keeps the work instead of failing the program.

## Constraints

- Flows follow the flow-script contract (`flows/README.md`): single file,
  published imports only, first-line `//` description.
- The clean-room wall is behavioral, not advisory: no flow rooted at the
  target may read legacy sources; verification reports against the frozen
  `rules.txt`.
- Deterministic tests where logic warrants extraction into packages (e.g.
  vector replay comparison already lives in `@llm4ts/flow/Equiv` with
  tests); flows themselves stay thin composition.
- Divergences from the pinned scripts get `docs/parity.md` notes.

## References

- Pinned source: `~/git/github/riccardomerolla/llm4zio/examples/modernize-{seed,implement,verify,review,bench}.sc`
- `packages/modernize/src/{Modernize,Approval,Artifacts}.ts` — the six-phase
  engine and resume helpers (consider a `modernize.ts` flow wiring
  `makeModernize` end-to-end once all phase bodies exist)
- `packages/flow/src/{Pack,Survey,Equiv,SpecChecks,Bench,BenchReport,ReviewCache}.ts`
- `flows/modernize-survey.ts`, `flows/modernize-extract.ts` — the shipped pair
