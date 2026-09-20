# Judgment decision map

The route from ADR 0017's integration foundation to a small local judgment
model that llm4ts can train, evaluate and improve. Each phase names the
decision it settles, the evidence that settles it, and what the phase
unlocks. Phases are sequential; nothing is automated on evidence from an
earlier phase alone.

Status column: `done` (in the tree), `next`, `later`.

## Destination decisions (settled 2026-09-20)

| Decision              | Choice                                                   | Why                                                                                 |
| --------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Deliverable           | Revised ADR 0017 plus this map                           | The ADR records the contract; the map records the route and its gates.              |
| What "seamless" means | Switching through llm4ts configuration only              | A TypeSafe-compatible HTTP server is a later, optional layer over the same service. |
| Initial scope         | Selected llm4ts decisions, not general-purpose judgments | Evidence is per task; a small model earns each automated decision separately.       |

## Phase 0: compatibility contract (done)

Decision: the typed contract every backend honours.

- Request: one `State`, keyed atomic `Choice` / `Score` / `Truth` questions.
- Answer: probabilities; `confidence` = the maximum probability on every
  backend (a hosted statistic is carried as `reportedConfidence`);
  `support` = mass placed on the offered options before renormalization;
  `origin` = backend, checkpoint, extraction method, calibration evidence,
  escalation flag.
- Errors: a backend failure fails the request; a question failure is
  reported beside the other answers; a label the model named but gave no
  mass is a parse failure, never a certainty.
- Identity: backend plus checkpoint, the cache key component.
- Uncertainty semantics: `decide` holds any answer below `minSupport`, then
  bands by calibration evidence (`measured`, `claimed`) and otherwise by
  method (`logprobs`, `sampled`, `reasoning`, `verbalized` in rising
  strictness).

Evidence: `packages/core/test/Judgment.test.ts`, `packages/flow/test/Judgment.test.ts`.

## Phase 1: evaluation baseline (next)

Spec: `specs/pending/judgment-evaluation-baseline.md`.

Workflow: [Labelling a decision](judgment-datasets.md).

Decision: what "good" means for each selected llm4ts decision.

Selected decisions, in order:

1. Review lens pre-screen: one Truth per lens over a diff.
2. Empty-diff confirmation: one Truth over the coder's reply.
3. Program judge dimensions: one Score per rubric dimension over spec and diff.

For each: a held-out labelled set built from llm4ts's own history (the
replay tool's commits, hand-labelled), and the measures the gate reads:
accuracy, calibration (expected calibration error over the label
probabilities), missed-issue rate by severity for the pre-screen, latency
per question, memory at rest and peak.

Gate to leave the phase: labelled sets exist for the three decisions and the
`pnpm judgment:replay` report carries the calibration and missed-issue
columns. Nothing automated yet: consumers run in **observe** mode, logging
`decide` outcomes beside what the full path did.

Known facts feeding this phase (2026-09-19 spike, same 4B weights):
label log-probabilities 19/20 correct at 0.22 s; verbalized JSON 17/20 at
1.26 s; log-probability distributions fully peaked (1.00 on the chosen
label even when wrong), so raw confidence is not an uncertainty signal and
`support` is the only honest local safeguard until calibration is measured.

## Phase 2: local candidates compared (later)

Decision: which local scorer becomes the trained backend.

Candidates on identical tasks and hardware:

- The existing `LlmJudgment` over `mlx-lm` label scoring (the baseline).
- A Jevlike-style trained scorer (MIT research starter, byte encoder,
  192-byte context by default, adjustable; no demonstrated Jev-equivalent
  quality). Its context limit must be raised or a frozen encoder used before
  code-review inputs are representative.
- The hosted TypeSafe model as the calibrated reference.

Gate: a table per selected decision with accuracy, calibration error,
latency and memory for every candidate. The trained scorer is adopted only
where it beats the baseline on calibration without losing accuracy.

## Phase 3: improvement tools (later)

Decision: the training lifecycle llm4ts owns.

- Dataset capture: every judgment in observe mode records state, question,
  answer, and later the outcome (the full path's verdict, or a human
  correction) to a versioned dataset.
- Correction: a small review surface for relabelling.
- Training and calibration: a checkpoint per run, calibrated on the held-out
  set (temperature scaling at minimum), producing `calibration: measured`.
- Evaluation: the Phase 1 measures rerun per checkpoint.
- Versioned checkpoints with promotion and rollback: the judgment identity
  changes with the checkpoint, so caches never mix.

Gate: a checkpoint promoted through the pipeline reaches production config
by a one-line change and can be rolled back the same way.

## Phase 4: gradual enablement (later)

Decision: which automated decisions are allowed, per task.

- Observe first: `decide` outcomes logged, nothing skipped.
- Then advise: outcomes shown to the operator beside the full path's result.
- Then automate: the pre-screen skips a lens, the confirmation probe
  replaces the literal match, the judge dimension replaces the generative
  score, each only after its own Phase 1 measures on a `measured`
  checkpoint clear the bar (for the pre-screen: zero Critical issues lost
  and at least 40% fewer reviewer-seat tokens over 30 commits).

Gate per consumer: the bar above, recorded in the consumer's spec, and a
kill switch back to observe mode.

## Later, optional: a TypeSafe-compatible HTTP server

Once a local backend is trusted, a small server exposing
`POST /v1/systemone` over the `Judgment` service lets TypeSafe SDK users
point at llm4ts by changing a base URL. Out of scope until Phase 4 has an
automated consumer; the contract in Phase 0 already mirrors the wire.
