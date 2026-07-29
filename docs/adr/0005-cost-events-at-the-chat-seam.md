# ADR 0005: Cost Events Are Produced At The Chat Seam

## Status

Accepted.

## Context

The dogfood loop's cost budget never tripped, and every run's cost summary
reported no usage. Investigation showed the cause was not (as first filed)
CLI connectors failing to report usage — six connectors already parse token
counts into streamed chunks — but that **nothing anywhere published
`TokensUsed`**: `CostTracker`, benchmarks, replay, and the terminal all
consume an event with zero producers. Usage reached `LlmResponse.usage` via
`collect` and was discarded.

## Decision

`TokensUsed` is produced at the flow layer, where responses are collected and
an event sink is in scope:

- `Chat` accepts `events`/`agent` options and publishes `TokensUsed` for
  every reply whose collected response carries usage. `implementPlanFlow`
  passes its context events with agent `"coder"`, so all plan/review traffic
  is metered by default.
- `completeAndPublish` publishes usage the same way (agent `"assistant"`).
- Connectors stay responsible only for parsing usage into chunk metadata —
  the existing `LlmChunk.usage` contract. CLIs that expose no usage
  (Antigravity, Copilot, Cursor) now declare `usageReporting: false` instead
  of inheriting a default `true`, and the capability matrix documents that
  budgets cannot trip for runs driven only by such connectors.
- The runner exposes its `CostTracker` on `FlowRunnerBundle` and accepts
  `FlowRunnerOptions.budget`, checked after the flow body completes with a
  typed `BudgetExceeded`. Post-completion checking bounds runaway _sequences_
  of runs, not a single run in flight; mid-run enforcement would require
  per-turn hooks and is deliberately deferred until a real consumer needs it.

## Consequences

- Cost summaries and budgets work for every seat whose backend reports
  usage, API and CLI alike; the "no usage reported" summary line now
  indicates a genuinely non-reporting backend rather than a broken pipeline.
- Flows that bypass `Chat`/`completeAndPublish` and call connector methods
  directly are unmetered unless they publish `TokensUsed` themselves.
