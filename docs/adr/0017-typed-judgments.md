# ADR 0017: Typed Judgments Over Local Or Hosted Probability Backends

Status: Proposed (revised 2026-09-20 after review) · Date: 2026-09-19

## Context

Every decision llm4ts makes from a model's reply today is a generative call
followed by parsing: the rubric judge (`packages/core/src/eval/Judge.ts`),
the spec-compliance `ProgramJudge`, the seven review lenses, the
`TASK_ALREADY_SATISFIED` empty-diff probe. Each one asks a large model to
write JSON or prose, decodes it, and branches on the result. That is slow,
expensive in output tokens, and fragile at the decode boundary
(`specs/pending/review-structured-robustness.md` was the first casualty).

TypeSafe's Jev (docs.typesafe.ai) names the alternative: a "System One"
model that evaluates atomic, typed questions against one state and returns
probabilities instead of text. Its three primitives (Choice, Score, and a
yes/no probability it calls Noul), its confidence statistic, and its
patterns (speculative fan-out, confidence-gated routing, composite scoring,
intent routing) are a good vocabulary for the decisions above. Jev itself is
proprietary, hosted only, priced per input token, and its distinguishing
property is calibration from reinforcement learning, which no local model
reproduces without training.

The goal beyond integration is a small local model llm4ts can train,
evaluate and improve for its own decisions. This ADR settles the contract
and the integration; `docs/judgment-decision-map.md` settles the route to
the trained model and the evidence each step needs.

Facts established on 2026-09-19:

- LM Studio's OpenAI-compatible server returns no token log-probabilities
  on either endpoint; it can only produce probabilities the model writes
  down itself. It does enforce `json_schema` output by grammar.
- `mlx-lm`'s server returns top-k log-probabilities (capped at 11) with the
  token text, accepts `logit_bias`, runs natively on Apple Silicon, keeps an
  LRU prompt cache, and loads text-only Hugging-Face-format MLX weights
  (LM Studio's Qwen 3.5+ community conversions are multimodal and do not
  load). llama.cpp's server would do the same for GGUF weights; Ollama
  documents log-probabilities as unsupported.
- With log-probabilities, a judgment needs no generation: one forward pass,
  one output token, the distribution read off the labels. On the same 4B
  weights: 19/20 correct at 0.22 s per question versus 17/20 at 1.26 s for
  verbalized JSON. The distributions were fully peaked (probability 1.00 on
  the chosen label, including the one wrong answer): a greedy instruct
  model's log-probabilities are not an uncertainty signal.

A review on 2026-09-20 found four defects in the first cut, all fixed in
this revision: confidence meant different things on different backends;
renormalizing over the offered labels could turn a sliver of mass into a
certainty; one enum mixed provider identity, extraction method, calibration
evidence and escalation history; and the answer cache did not know which
checkpoint had answered.

## Decision

### A `Judgment` capability in core, with Jev's vocabulary

`packages/core/src/judgment/` adds a `Judgment` service: a request is one
`state` (string, object, or array of strings) and a keyed map of atomic
`questions`; the result is a keyed map of typed answers plus the questions
that failed. The three question kinds and their answers mirror Jev's wire
names so its cookbooks port by search and replace, with these changes:

- `noul` is called `truth`, because an llm4ts reader should not need
  TypeSafe's glossary (`CONTEXT.md`).
- `confidence` is the maximum probability on every backend. A hosted
  service's own statistic is carried beside it as `reportedConfidence`, so
  switching backends never changes what the field means.
- every answer carries `support`: the probability mass the backend placed
  on the offered options before renormalization (1 when the numbers were
  declared over the options alone). An answer rebuilt from a sliver is
  reported as such, and policy holds it whatever its confidence.
- every answer carries an `origin` with four separate facts: `backend` and
  `model` (which checkpoint), `method` (how the probabilities were
  extracted: `logprobs`, `verbalized`, `sampled`, `reasoning`, `hosted`),
  `calibration` (`none`, `claimed` by the provider, `measured` by an
  evaluation in this project), and `escalated`.
- a label the model names but gives no probability is a parse failure,
  never a manufactured 1.0. Questions over one state are answered
  independently.

Definitions: `score` is the expected level index; a Truth answer is the
probability alone and has no confidence.

### Three layers behind one interface, each with an identity

- `TypeSafeJudgment`: HTTP to `api.typesafe.ai`, key from
  `TYPESAFE_API_KEY` as `Redacted`, native batching of all questions in one
  request, cost events at the published input price, calibration
  `claimed`. TypeSafe is a `JudgmentBackend`, not a `ConnectorId`: it has
  no chat, stream, or tool surface.
- `LlmJudgment`: over any `LlmServiceShape`, one call per question with
  layer-configured `concurrency` (default 1) and `permutations` (default 1;
  2 averages a reversed option order), calibration `none`.
- `FakeJudgment`: deterministic answers for CI. Default CI needs no network,
  no key, no local server.

Every layer exposes `identity` (backend plus checkpoint). Cached answers
are fingerprinted on state, questions and identity, so a retrained or
swapped local model never reuses its predecessor's answers. A trained local
scorer (decision map, Phase 2) is a fourth layer over the same interface.

### One new primitive on the LLM service, not a side door

`LlmServiceShape` gains `scoreLabels(prompt, labels)`, returning a
probability per label with its `method` and `support`, and connectors
declare `labelProbabilities: "logprobs" | "verbalized" | "none"`. The
default implementation asks for schema-constrained JSON through
`executeStructured` (method `verbalized`, support 1 by construction). A new
`mlx-lm` API connector, an ordinary `makeApiConnector` provider with a row
in the identity table, overrides it with a single-token log-probability
read whose support is the absolute mass on the labels. The runner and flow
stay ignorant of which path answered.

Label contract: single-token letter labels for Choice and Score levels,
`yes`/`no` for Truth, a fixed prompt template, labels matched on token text
after stripping the byte-level space marker. A question whose labels are
absent, or whose JSON does not decode, is retried once through the
verbalized path with its method recorded and an event published; if that
fails, that question alone fails typed while the others still answer.

### Policy lives in flow

Core answers questions and reports their origin; it never decides what to
do with a number. `packages/flow` owns a typed `JudgmentPolicy`: a
`minSupport` below which any answer is held, then certainty bands keyed
first by calibration evidence (`measured`, `claimed`) and otherwise by
method, in rising strictness `logprobs`, `sampled`, `reasoning`,
`verbalized`. It also owns escalation of held or failed answers to the
`reasoning` seat (origin `reasoning`, `escalated`), and fingerprint caching
of answers. The runner adds a fourth seat, `judgment`, defaulting to
`reasoning`, so a flow can point judgments at a small non-thinking model.

### Consumers are enabled gradually, per task

1. The rubric judge in `core/eval` re-expressed as Score questions: the
   reference implementation and test bed.
2. A Truth fan-out pre-screen before the review lenses.
3. The empty-diff confirmation as one Truth question.
4. The modernize judge stage on the same helpers.

Each consumer starts in observe mode (outcomes logged beside the full path),
and automates only on task-specific evidence from a `measured` checkpoint,
recorded in its spec (for the pre-screen: zero Critical issues lost and at
least 40% fewer reviewer-seat tokens over 30 llm4ts commits). The
`prescreen` option is off by default until then.

## Consequences

- Typed answers replace parsed prose at the decision points named above,
  and the fake layer makes every decision path testable without a model.
- A local judgment costs one forward pass and one output token where the
  backend exposes log-probabilities; elsewhere it costs a short JSON reply.
- No local backend is calibrated until Phase 3 of the decision map
  produces `measured` evidence. Until then `support` is the only honest
  local safeguard, local confidence bands are deliberately strict, and
  consumers observe rather than act.
- The pre-screen re-sends the state once per question to the judgment
  seat; its tokens are reported separately from the reviewer seat's because
  the two seats' tokens do not cost alike.
- ADR 0005 is amended: cost events are also produced by the judgment layers,
  so the chat seam is no longer the only producer.
- This diverges from pinned `llm4zio` v4.3.0, which has no equivalent; the
  parity ledger records it as an accepted addition.
- Superseded by nothing yet; the decision map's later phases (a trained
  local scorer, a TypeSafe-compatible HTTP server) each get their own ADR
  when their evidence is in.
