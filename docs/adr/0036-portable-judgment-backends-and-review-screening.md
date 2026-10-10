# ADR 0036: Portable Judgment Backends And Review Screening

Status: Proposed (draft) · Date: 2026-10-10 · Extends ADR 0017

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
Compare against the unscreened flow and, where useful, hosted TypeSafe and a
dedicated local classifier. The first integration is llama.cpp; a specialized
classifier adapter remains a later option if evidence supports it.

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
[Earendil article](https://earendil.com/posts/you-said-no-mcp/).
