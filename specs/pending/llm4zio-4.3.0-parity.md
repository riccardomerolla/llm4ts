# Parity update: adopt llm4zio v4.3.0

Upstream released v4.3.0 (`0494a4ad`, 2026-08-01) — 31 commits past our
pinned v4.2.0 (`adf23e11`), all in flow, modernize, and examples. The theme
is **bounded context for the modernization pipeline**: every phase could die
against a provider's input-token ceiling (Gemini: hard `400 INVALID_ARGUMENT`
at 1M tokens), from four independent causes upstream fixed together. One of
those causes is a live bug in llm4ts today: `TransientRetry` classifies the
substring `"api error"` as transient
(`packages/flow/src/TransientRetry.ts:18`), and Gemini wraps every error —
including deterministic 400s — in `[API Error: …]`, so an unfixable failure
is retried three times and reported as transient.

Blast radius: one new flow module (`Context`), three flow modules touched
(`TransientRetry`, `GitTool`, `Pack`), one additive defaulted `Provenance`
field, five `flows/modernize-*.ts` scripts, tests, parity ledger. No breaking
API changes. Two deliberate behavior changes: deterministic 4xx stops being
retried, and review/verify/judge prompts decompose per program.

Stages are ordered so each ships alone; stage 1 is a bug fix and should not
wait for the rest.

## Decisions

| Question                       | Decision                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Env knob names                 | `LLM4TS_CONTEXT_BUDGET` (chars, default 400_000), with the existing `LLM4TS_JUDGE_SOURCES_LIMIT` (`flows/modernize-extract.ts`) kept as the deprecated alias — mirrors upstream's `LLM4ZIO_CONTEXT_BUDGET` / `LLM4ZIO_JUDGE_SOURCES_LIMIT` pair. New knobs: `LLM4TS_ANALYST_TURNS`, `LLM4TS_MAX_CLOSURE_FILES`. Record the renames in `docs/parity.md`. |
| Budget unit                    | Characters, not tokens — deterministic, no tokenizer dependency, same as upstream (~3.5 chars/token; 400k ≈ 115k tokens, conservative for every provider).                                                                                                                                                                                              |
| Truncation storage             | Fiber-local (`FiberRef`), written **only** by `capped`/`withShrink`, so no call site can truncate without recording, and concurrent flows don't cross-contaminate. Same rule as upstream.                                                                                                                                                               |
| `ProgramJudge` placement       | `@llm4ts/flow` (like `Review.ts`, `SpecChecks.ts`), not `@llm4ts/modernize` — llm4ts phase logic lives in `flows/*.ts` scripts, so shared seams must sit in the flow package to be testable and reusable. Divergence from upstream's module layout; note it in `docs/parity.md`.                                                                        |
| `withShrink` cause suppression | Upstream drops the typed cause on terminal shrink failure because its `AutoResume` would otherwise replay the failing budget ladder forever. llm4ts has no AutoResume — still drop the cause (embed its message in the error text, as upstream does) so the behavior contract matches and a future resume feature cannot reintroduce the loop.          |
| v4.2.0 remainder               | Out of scope: the v4.2.0 tracked-capabilities work is already ported; upstream's `examples/*.sc` compile fixes are Scala-specific. The orca read-only-allowlist finding is a separate spec.                                                                                                                                                             |

## Tasks

### Stage 1 — TransientRetry: stop retrying deterministic failures (bug fix)

- [ ] Add a deterministic-4xx guard to `isTransient`
      (`packages/flow/src/TransientRetry.ts`): a `ProviderError` whose message
      matches `invalid_argument`, `"code": 400` / `"code":400` / `code=400`,
      or `exceeds the maximum number of tokens` is **never** transient, even
      when `"api error"` or another transient signal also matches.
- [ ] Export `isContextOverflowMessage(message)` — the one phrasing list for
      prompt-too-large failures (`exceeds the maximum number of tokens`,
      `input token count exceeds`, `context length exceeded`,
      `maximum context length`, `prompt is too long`, `request too large`) —
      and `isContextOverflow(error)` matching it on a typed `ProviderError`.
      One list, two matchers: `Context.withShrink` (stage 2) reuses the
      message form so the copies cannot drift.
- [ ] Keep the upstream comment discipline: `isFlakyStream`'s
      `empty response` is deliberately ambiguous (mid-stream flake vs
      prompt-too-large) and must NOT be routed into `isContextOverflow`; the
      overflow case is resolved a layer up by `withShrink`.
- [ ] Port the upstream `TransientRetrySpec` additions to
      `packages/flow/test/TransientRetry.test.ts`: a Gemini-wrapped 400 is not
      transient; each overflow phrasing matches; overflow is not transient;
      flaky-stream classification unchanged.

### Stage 2 — `flow.Context`: the budget primitive, and truncation provenance

- [ ] New `packages/flow/src/Context.ts` porting `llm4zio/flow/Context.scala`:
  - `cap(text, limit)` → `{ text, originalChars, truncated }`. The result is
    never longer than `limit`, marker included (upstream fixed the old
    marker-on-top overshoot); keeps head ¾ / tail ¼ of the remaining room;
    `limit <= 0` yields `""`.
  - `budget` — `LLM4TS_CONTEXT_BUDGET`, else deprecated
    `LLM4TS_JUDGE_SOURCES_LIMIT`, else 400_000.
  - `Truncation { label, originalChars, keptChars, kind }` with
    `kind: "capped" | "shrunk"` and a `render` that keeps the two readable as
    different things — `capped` numbers are literal char counts, `shrunk`
    numbers are attempted budget **ceilings**. Conflating them misreports how
    much content an audit actually lost.
  - `capped(label, text, limit)` — caps, publishes a `FlowEvent` `Info`
    (`⚠ context: <label> truncated N → M chars`), records the truncation.
  - `truncations` — read back this fiber's recorded truncations.
  - `withShrink(label, start?)(f: (chars) => Effect)` — run at `start`
    (default `budget`); on a shrinkable failure retry at ½ then ¼, publishing
    and recording each shrink; on exhaustion fail with a `FlowError` naming
    `LLM4TS_CONTEXT_BUDGET` and embedding the cause message (no typed cause —
    see Decisions). Shrinkable = `isContextOverflow` on the cause,
    `isContextOverflowMessage` on the message, or `empty response` (the
    Gemini too-large-to-start signature).
- [ ] `Provenance` (`packages/flow/src/Provenance.ts`): add
      `contextTruncations` as a **defaulted** list of rendered strings so
      manifests written before the field still load
      (`Schema.withConstructorDefault` + optional-with-default decode, per
      the schema-boundary rule).
- [ ] Tests: port `ContextSpec` → `packages/flow/test/Context.test.ts`
      (hard-cap property incl. marker, head/tail split, `limit <= 0`, budget
      fallback order, ladder sequence full→½→¼, every truncation recorded,
      shrink-exhaustion error names the knob) and the `ProvenanceSpec`
      addition (old manifest without the field parses).

### Stage 3 — Scoping seams: `GitTool.diffVsBase(paths)` and `Pack.programFiles`

- [ ] `GitTool` (`packages/flow/src/GitTool.ts`): path-scoped overload
      `diffVsBase(base, paths, threeDot?)`. An **empty `paths` list yields
      `""`, never the whole diff** — bare `git diff <range> --` means
      "everything", which would silently defeat every caller scoping by a
      computed, possibly-empty file set. The empty check runs **inside** the
      `read(...)` capability guard, not before it: an early return would let
      `diffVsBase(base, [])` succeed under grants that deny `GitRead` with no
      `CapabilityDenied` audit event.
- [ ] `Pack` (`packages/flow/src/Pack.ts`): parse the optional
      `programFiles:` manifest field (regex template, `<NAME>` substituted)
      and add `filesFor(program)` — the template applied, or a
      case-insensitive regex-quoted "path contains the program name"
      fallback. This is the seam that makes per-program judging possible.
- [ ] Tests: `GitTool` — empty paths → `""` with the guard still consulted
      (denied grants still fail typed); non-empty paths reach argv after
      `--`. `Pack` — template substitution, fallback, quoting of regex
      metacharacters in program names.

### Stage 4 — Modernize pipeline: bounded, per-program decomposition

- [ ] `flows/modernize-implement.ts`: fresh `Chat` per task (today one
      `coderChat` at line ~194 is reused across every task, so task N replays
      all N−1 transcripts); the repo, not the transcript, carries state
      between tasks. Review-fix rounds within one task share that task's
      chat. Overlaps deliberately with
      `specs/pending/flow-per-task-chat.md` — that spec changes the
      **library** (`implementPlanFlow`); this task changes the **flow
      script**. If slice 1 of that spec lands first, use its policy here
      instead of hand-rolling.
- [ ] `ProgramJudge` in `@llm4ts/flow`: cached per-program spec-compliance
      judging (port `llm4zio/modernize/ProgramJudge.scala`), using
      `Pack.filesFor` + `GitTool.diffVsBase(paths)` so each judge call sees
      one program's spec and one program's diff — not the whole pack times
      the whole branch.
- [ ] `flows/modernize-review.ts`: each reviewer lens sees only the diff of
      the files it matched (`diffVsBase(paths)`); per-program
      spec-compliance judging + traceability pass; stop resending the full
      diff in the distill step.
- [ ] `flows/modernize-verify.ts`: triage equivalence failures per program
      instead of concatenating every program's spec into one prompt; a
      spec'd program with **no matching changed file is a Critical gate
      finding**, not a silent pass (this also surfaces a mis-set
      `programFiles:` immediately).
- [ ] `flows/modernize-extract.ts`: replace the analyst's "read the source
      file and anything it references" open-ended instruction (line ~114)
      with a deterministically resolved **include closure** — walked
      breadth-first over the pack's `## Survey:` edge regexes — handed to the
      analyst as context; bound by `LLM4TS_ANALYST_TURNS` and
      `LLM4TS_MAX_CLOSURE_FILES`. This is the fix for the inner CLI agent
      blowing a 1M window while its own cap sat at ~115k.
- [ ] `flows/modernize-survey.ts`: cap the graph-refine and triage prompts
      with `Context.capped`.
- [ ] Implement / verify / review phases append `Context.truncations` to
      `provenance.json` under `contextTruncations` at phase end.
- [ ] Verify `Provenance.llm4tsVersion` reports the real published version
      (upstream's `SeedFlow.Llm4zioVersion` had gone stale — check ours).
- [ ] Tests: port `ChatPerTaskSpec`, `IncludeClosureSpec`,
      `ProgramJudgeSpec`, `VerifyTriageSpec`, `ImplementFlowSpec`, and the
      `TestPacks` fixtures with `@effect/vitest` against the in-src fakes.
      Logic that today lives only in `flows/*.ts` and needs these tests gets
      lifted into `@llm4ts/flow` first (see Decisions) — `flows/test/` only
      covers pack-shape smoke today.

### Stage 5 — Repin and record

- [ ] `plan.md` Pinned Baselines: reference release `v4.3.0`, commit
      `0494a4ad`.
- [ ] `docs/parity.md`: same repin; new ledger rows (`Context.scala` →
      `@llm4ts/flow/Context`, `ProgramJudge.scala` → `@llm4ts/flow/…`, the
      `Pack`/`GitTool`/`Provenance`/`TransientRetry` row updates); parity
      notes for the env-var renames, the `ProgramJudge` module placement,
      and the `withShrink` no-AutoResume note.
- [ ] `CHANGELOG.md` entry; `docs/api.md` (Context, diffVsBase,
      programFiles).
- [ ] Full verification chain: `pnpm typecheck && pnpm lint &&
pnpm format:check && pnpm test`, then `pnpm build &&
node scripts/pack-smoke.mjs`.

## References

- Upstream: `/Users/riccardo/git/github/riccardomerolla/llm4zio` at `v4.3.0`
  (`0494a4ad`); read `CHANGELOG.md` §4.3.0 and
  `git diff adf23e11..v4.3.0 -- modules/llm4zio-flow modules/llm4zio-modernize`
- Key upstream sources: `flow/Context.scala`, `flow/TransientRetry.scala`,
  `flow/Pack.scala`, `flow/GitTool.scala`, `flow/Provenance.scala`,
  `modernize/ProgramJudge.scala`, `modernize/ImplementFlow.scala`
- llm4ts counterparts: `packages/flow/src/{TransientRetry,Pack,GitTool,Provenance,FlowEvents}.ts`,
  `flows/modernize-*.ts`
- Related: `specs/pending/flow-per-task-chat.md` (library-side per-task
  chat), `docs/parity.md`, `plan.md` "Pinned Baselines"
