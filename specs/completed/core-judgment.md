# Core `Judgment` Service: Choice, Score, Truth Over One State

Order: first of the judgment specs. `mlx-lm-connector`, `judgment-seat`,
`judgment-flow-helpers`, and `reviewer-prescreen-and-measurement` depend on
it. ADR 0017; vocabulary in `CONTEXT.md`.

## Why

Decisions made from model prose are slow, expensive, and fragile at the
decode boundary. A judgment asks atomic typed questions against one state
and gets probabilities back, with an `origin` saying which backend and
checkpoint produced them, how they were extracted, and what is known about
their calibration, and a `support` saying how much mass sat on the options. Wire names mirror TypeSafe's Jev so its cookbooks port by search
and replace, except `noul` is `truth` and every answer carries `origin` and `support`.

## Shape

`packages/core/src/judgment/`, exported as `@llm4ts/core/judgment/*`.

- `Schemas.ts`: `State` (string | object | array of strings), `Description`
  (string | object | array | null, as Jev's `EntryType`), `ChoiceQuestion
{ type: "choice", instructions, criteria: Record<key, Description> }`,
  `ScoreQuestion { type: "score", instructions, criteria: Array<Description> }`,
  `TruthQuestion { type: "truth", instructions, criteria?: { true, false } }`,
  `ScoringMethod` (`logprobs | verbalized | sampled | reasoning | hosted`),
  `Calibration` (`none | claimed | measured`), `AnswerOrigin { backend,
  model?, method, calibration, escalated }`,
  `ChoiceAnswer { choice, probabilities, confidence, reportedConfidence?, support, origin }`,
  `ScoreAnswer { score, legend, probabilities, confidence, reportedConfidence?, support, origin }`,
  `TruthAnswer { truth, support, origin }`, `JudgmentRequest { state, questions }`,
  `JudgmentResult { answers, usage?, backend }`. Confidence = max
  probability; score = expected level index. A typed `AnswerFor<Q>` maps
  each question key to its answer type at the call site.
- `Judgment.ts`: the service (`Effect.Service`), `judge(request)`, errors as
  `Schema.TaggedError` (`JudgmentError` variants: backend failure, question
  failure with key, unsupported state size).
- `LlmJudgment.ts`: layer over `LlmServiceShape`. Config `{ concurrency: 1,
permutations: 1 }`. Per question: build the label prompt (fixed template:
  state first, then instructions, then lettered options or `yes`/`no`),
  call `scoreLabels`; on `LabelsNotObserved` or decode failure retry once
  through the verbalized path with method `verbalized` and publish an
  event; on second failure that question alone fails, the others answer.
  `permutations: 2` runs the reversed option order and averages.
  Publishes `TokensUsed` with agent `"judgment"` (ADR 0005 amendment).
- `TypeSafeJudgment.ts`: layer over `HttpClient`. `POST
https://api.typesafe.ai/v1/systemone`, bearer key from `TYPESAFE_API_KEY`
  as `Redacted`, one request per `judge` call (native batching), `noul`
  translated to `truth` on the way in and out, calibration `claimed`,
  confidence recomputed as the peak with the wire statistic kept as
  `reportedConfidence`,
  cost from `usage.input_tokens` at the published input price.
- `FakeJudgment.ts`: deterministic layer for tests, answers from a table
  keyed by question key with a default.
- `JudgmentBackend` identity: `typesafe | llm | fake`; not a `ConnectorId`.

## `scoreLabels` primitive

- `LlmServiceShape.scoreLabels(prompt, labels: ReadonlyArray<string>) =>
Effect<LabelDistribution, LlmError>` where `LabelDistribution
{ probabilities: Record<label, number>, method, support }`.
- `ConnectorCapabilities.labelProbabilities: "logprobs" | "verbalized" | "none"`,
  default `verbalized`.
- `makeApiConnector` and `makeCliConnector` derive the default
  implementation from `executeStructured`: schema-constrained JSON
  `{ label, probabilities }`, renormalized, method `verbalized`, support 1;
  a reply naming a label it gave no mass is a `ParseError`, never a 1.0.
  Mock and fake providers implement it deterministically.

## Consumer 1: the rubric judge

`packages/core/src/eval/Judge.ts` gains `judgeWithJudgment(judgment,
dimensions)`: each dimension becomes a Score question whose levels are the
rubric's integer scale; `EvalResult` scores are the rounded expected level,
`reasoning` records origin, confidence and support. The existing generative
`judge` stays.

## Tasks

- [ ] Schemas with encode/decode tests, including `AnswerFor` typing.
- [ ] `scoreLabels` on the service shape, capability flag, default
      derivation in both connector factories, mock/fake implementations.
- [ ] `LlmJudgment` with tests on the fake LLM: label prompt shape,
      renormalization, fallback path and event, per-question failure
      isolation, `permutations: 2` averaging, concurrency bound.
- [ ] `TypeSafeJudgment` with HTTP-fake tests: request body, `noul`/`truth`
      translation, key never in logs or errors, cost event.
- [ ] `FakeJudgment`.
- [ ] `judgeWithJudgment` in `eval/Judge.ts` with tests.
- [ ] Subpath exports, `docs/api.md` section, CSP `02-public-api` note.
