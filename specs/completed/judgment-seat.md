# Runner: A `judgment` Seat

Order: after `core-judgment`. Small. ADR 0017.

## Why

Judgments want a small, fast, non-thinking model; the coder and reasoning
seats usually want the opposite. The runner resolves `coder`, `reasoning`,
and `reviewers` seats (`packages/runner/src/FlowRunner.ts`, `seatsFor`); a
fourth seat lets a flow point judgments elsewhere without touching the
others.

## Tasks

- [ ] `FlowRunnerOptions.judgment?: ConnectorConfig`, defaulting to the
      reasoning seat's config (which itself defaults to the coder).
- [ ] Resolve it through `resolveSeat` so it gets `resilient` retries and
      the read-only grade announcement like every other seat.
- [ ] `FlowContextShape.seats.judgment: LlmServiceShape` and a
      `FlowContextShape.judgment: JudgmentShape` built with `LlmJudgment`
      over that seat by default; a `judgmentBackend` option selects
      `typesafe` (key from env) or `fake`.
- [ ] `LLM4TS_JUDGMENT_PROVIDER` / `LLM4TS_JUDGMENT_MODEL` env selection
      mirroring `apiConnectorFromEnvironment`.
- [ ] Tests: default falls back to reasoning; explicit config resolves;
      the seat appears in the context; env selection.
- [ ] `docs/configuration.md` seat table row.
