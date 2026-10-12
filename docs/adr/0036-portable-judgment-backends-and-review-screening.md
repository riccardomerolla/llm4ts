# ADR 0036: Portable Judgment Backends And Review Screening

Status: Proposed (draft, reviewed against JEV-CPU) · Date: 2026-10-10 · Extends ADR 0017

## Context

The operator reports that model calls consume roughly 95% of flow execution
time, especially in `epic-stories`. The goals are lower API cost and shorter
complete flow execution. This estimate motivates the proposal; a representative
run must establish the baseline before claiming a speedup.

`epic-stories` spends model time planning Tasks, implementing code, reviewing
changes, fixing findings, and judging completed stories. Its default path has
no frequent short hosted Judgment that a local scorer can simply replace.
The empty-diff probe uses literal matching by default; enabling its optional
Judgment would add a call. A useful local scorer must instead help avoid
expensive work, beginning with selected review lenses.

ADR 0017 and `packages/core/src/judgment/` already provide the desired
abstraction: one State, keyed Choice / Score / Truth Questions, typed answers,
probabilities, Support, and Origin. TypeSafe and LLM adapters exist. The
review pre-screen in `packages/flow/src/Review.ts` can observe selections or
skip lenses, and retains full review on doubt or failure. The proposal builds
on this foundation.

[JEV-CPU](https://github.com/leesk212/JEV-CPU) supplies a concrete comparison
candidate: it runs SemIf option scoring with ordinary Qwen3-0.6B weights on
CPU. This demonstrates an inference technique, rather than a new trained
decision model or evidence of Jev-equivalent calibration. Its code and
[technical report](https://leesk212.github.io/JEV-CPU/) were reviewed on
2026-10-10 at commit `b49b5bf5776af78495fa4900996042726f8e7c10`;
published measurements have not been reproduced in llm4ts.

## Decision

### Extend Judgment across local and remote deployments

Keep `Judgment` as the interface flows use. CPU, GPU, and remote placement
belong to adapter configuration; callers continue asking typed Questions.
Keep the TypeSafe adapter for remote System One inference and the fake
adapter for deterministic tests. Add llama.cpp endpoint support through the
existing LLM judgment path where practical, rather than introducing a second
public judgment interface.

The initial local deployment connects to a separately managed, long-running
inference process that keeps its model loaded between requests. Configure the
endpoint and model explicitly. The same integration can address CPU or GPU
deployments; throughput, memory, and latency are evaluated on the target
hardware. Starting a model process for each Judgment is outside this design.
No particular checkpoint is selected by this ADR.

### Require direct option scoring for the local pilot

The local pilot reads option probabilities from the next-token distribution
without generating a JSON answer. Each option maps to a verified, distinct
single-token label at the answer boundary. Unsupported tokenization fails
explicitly. A verbalized fallback remains possible through existing policy,
but is recorded separately and cannot establish the direct scorer's performance.

JEV-CPU's [direct scorer](https://github.com/leesk212/JEV-CPU/blob/b49b5bf5776af78495fa4900996042726f8e7c10/src/semif_phase1/direct.py)
validates label tokenization, rejects prompts exceeding its configured cap,
and takes final-position logits in one forward pass. Use it as a reference
implementation and comparison candidate alongside llama.cpp label scoring.
llama.cpp remains the first integration, subject to verifying that its endpoint
exposes the required unconstrained label probabilities and Support.

Option-normalized probabilities require special care: they give relative
preference among offered answers. The direct scorer returns their logits and
conditional probabilities, but does not return full-vocabulary label mass.
An llm4ts adapter must compute Support before discarding the vocabulary:
`exp(logsumexp(option logits) - logsumexp(vocabulary logits))`, or sum
equivalent unrestricted label probabilities. A constrained distribution or
renormalized option vector cannot reconstruct that mass. Do not manufacture
Support=1 for this readout; an endpoint missing the information must be adapted
before satisfying the existing contract. Calibration remains `none` until
decision-specific evaluation supports a measured claim.

### Evaluate shared State reuse separately from HTTP batching

Review screening asks multiple Questions over one diff. Evaluate a shared
State prefill with isolated Question branches or equivalent validated caching
to avoid processing the diff once per lens. Preserve each Question's isolation
from other Questions and their answers. Shared execution must be evaluated
against independent scoring for quality as well as speed; identical prompts
and probabilities cannot be assumed across different layouts.

The bundled [shared scorer](https://github.com/leesk212/JEV-CPU/blob/b49b5bf5776af78495fa4900996042726f8e7c10/src/semif_phase1/shared.py)
reuses a token-compatible State prefix and duplicates its cache for Question
branches. CPU performance and model compatibility must still be verified. Its
[HTTP server](https://github.com/leesk212/JEV-CPU/blob/b49b5bf5776af78495fa4900996042726f8e7c10/server.py) loops
over direct scoring calls under a global lock. A multi-question request to
that server therefore supplies neither shared prefill nor concurrent inference.
Treat it as an experimental endpoint. Any adapter must preserve per-question
failures and provide checkpoint/scoring identity, Support, readiness, and
bounded requests. Its current response omits Support and resolved checkpoint
identity. Do not adopt the demo server unchanged as the deployment contract.

### Make backend capabilities explicit

A common interface does not imply equal model quality or universal Question
support. Backends declare supported Question kinds, input limits, batching
capabilities, and any restrictions to particular versioned decisions. A
specialized classifier can support review screening without supporting
arbitrary Questions. Unsupported Questions produce explicit failures; they
must not produce guessed answers or silently truncate State.

Adapters validate answer kinds, option keys, probability bounds, and
distribution consistency. Preserve the existing distinctions among Confidence,
reported provider confidence, Support, Method, and Calibration. Constrained
output and peaked label probabilities do not establish correctness or
calibration; Support alone does not establish that an input is suitable.

Bind measured evidence to the decision, Question version, checkpoint, scoring
configuration, and evaluation dataset. Cache identity must distinguish resolved
checkpoints and scoring configurations, including prompt templates. Mutable
model aliases alone are insufficient for cache reuse across runs.

### Configure selection and fallback per decision

Choose the backend explicitly for each decision. Keep thresholds, escalation,
and actions in the flow layer, as ADR 0017 requires. Configuration can nominate
a remote Judgment fallback; this is optional and its additional cost and
latency count toward the decision's evaluation.

For review screening, unsupported inputs, unavailable endpoints, malformed
answers, and held or failed judgments retain the affected full reviews. Only
a successful answer from a backend validated for this decision may justify
skipping a lens. Automatic backend selection based on hardware or live latency
is deferred until comparative evidence exists.

### Pilot review screening in epic-stories

Ask one Truth Question per review lens over the changed code: whether the lens
would report a concrete issue. Reuse the existing pre-screen consumer and begin
in observe mode. Record predictions beside full review outcomes; observation
does not skip work and may increase execution time during evaluation.

Evaluate llama.cpp with configurable small models on representative diffs.
Include JEV-CPU/SemIf direct scoring as an immediate local comparison rather
than deferring all alternative scorers. Compare against the unscreened flow
and, where useful, hosted TypeSafe and a dedicated local classifier. A production
adapter for another scorer requires evidence that it satisfies the contract
and improves the pilot's outcomes.

The JEV-CPU report's roughly one-second examples are short illustrative cases.
Its input-length study reports 26 seconds for 2,629 tokens and 66.1 seconds
for 5,165 tokens on one 8 GB CPU machine. These are author-reported forward
times, not end-to-end or multi-lens throughput guarantees. Its accuracy section
also reports 0.440 mean-family authored balanced accuracy for the default
0.6B model from upstream evaluation. That evaluation used native BF16
checkpoints; it does not measure this CPU float32 deployment, quantized
llama.cpp weights, or review-screening accuracy.
Neither the demonstrations nor the architectural context window establishes
a suitable model or practical diff budget. See the
[report's latency and accuracy sections](https://leesk212.github.io/JEV-CPU/).

Do not shorten State merely to fit a small model without evaluating the
changed decision. Oversized or unsupported inputs retain full review.
Prediction of review relevance does not replace implementation, story
acceptance checks, or the review findings needed to guide a fix.

### Promote on flow-level evidence

Use human-labelled held-out cases and observed full reviews, keeping their
roles distinct. Split by source change so lenses or copies of one diff cannot
leak between tuning and evaluation. Full review outcomes are a comparison
baseline, not proof that every defect has been found.

Record API spend across screening, fallback, review, and subsequent fixes;
complete flow elapsed time; screening latency and queueing; memory; input
sizes; skipped lenses; fallback frequency; and missed actionable findings by
severity. Preserve checkpoint, configuration, hardware, and dataset identities
with the report.

Measure warm and cold requests, complete multi-lens latency, and concurrent
stories; separate tokenization, prefill, readout, and queueing where available.
Compare direct and shared execution at realistic input lengths. Pin scorer
code, tokenizer, checkpoint, numeric precision, and quantization in evaluation
identity: the JEV-CPU loader defaults to a mutable model revision, and its
CPU float32 results cannot be assumed for a quantized llama.cpp deployment.
Set full-prompt token limits, including Questions and options, and latency
deadlines per deployment; a nominal context window is not an acceptable
latency budget. The published CPU timing table is useful motivation, but a
reproducible target-server benchmark must establish the pilot's budget.

Skipping is opt-in and requires all three on held-out evaluation:

- Lower API cost than full review, including judgment and fallback calls.
- Lower complete flow elapsed time, including screening and later repair rounds.
- No actionable findings lost relative to the full-review baseline.

For this pilot, these requirements strengthen ADR 0017's gate of zero Critical
issues lost and fewer reviewer tokens. Existing gates for other consumers are
unchanged. Sample size, latency targets, and the exact meaning of an actionable
finding must be recorded in the pilot's evaluation specification before tuning.

Review lenses already run concurrently. Avoided calls can save money while
leaving the slowest retained review on the critical path; summed parallel call
durations are not elapsed-time savings. Keep an immediate switch back to full
review, and re-evaluate after checkpoint or Question changes. Zero observed
misses on held-out cases is a promotion criterion, not a guarantee about future
changes.

## Considered Options

- **A new Jev-specific interface:** duplicates the existing Judgment contract
  and couples callers to a provider's terminology.
- **A dedicated classifier first:** potentially cheaper inference, but needs
  evidence that it can evaluate representative code diffs and lens Questions.
  It remains a supported direction after the llama.cpp pilot.
- **Adopt JEV-CPU unchanged:** useful experimental reference, but its current
  HTTP response and serial scoring do not meet the Support, identity, or shared
  execution requirements. Compare the scoring approach before choosing a
  production adapter.
- **Automatic backend routing first:** adds policy before comparative cost,
  latency, and quality evidence exists. Explicit per-decision configuration
  makes the initial experiment reproducible.
- **Faster hosted reviewers or fewer repeated model turns:** remain valid
  alternatives. If local screening fails the flow-level gate, these may better
  serve the execution-time goal.

## Consequences

Flows gain portable Judgment implementations while retaining ownership of
actions. Local inference adds endpoint operation and capacity management;
CPU/GPU sharing with other flow work can erase expected savings. Maintaining
decision-specific evidence and reliable cache identities becomes part of
backend promotion.

This ADR authorizes a design direction, not default review skipping. Model
selection, capability metadata, configuration syntax, endpoint protocol details,
and the evaluation specification remain implementation work. A TypeSafe-compatible
server, local model training, and broader consumer adoption remain later work
under the [Judgment decision map](../judgment-decision-map.md).

References: [ADR 0017](0017-typed-judgments.md),
[dataset and evaluation workflow](../judgment-datasets.md), and the motivating
[Earendil article](https://earendil.com/posts/you-said-no-mcp/). Local comparison:
[JEV-CPU repository](https://github.com/leesk212/JEV-CPU),
[CPU loader](https://github.com/leesk212/JEV-CPU/blob/b49b5bf5776af78495fa4900996042726f8e7c10/semif_cpu.py), and
[technical report](https://leesk212.github.io/JEV-CPU/).
