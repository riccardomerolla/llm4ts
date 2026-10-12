# Cost Observability Gaps Surfaced by the Dogfood Loop

The dogfood loop (`tools/loop/`, from `specs/pending/dogfood-loop.md`) wired a
per-run USD budget via `CostBudget`/`checkCostBudget` and a per-task budget
check driven by a `CostTracker` attached to the flow event hub. Building it
surfaced three concrete library gaps. Each is a forcing-function finding, filed
here per the dogfood-loop's "record every gap as a spec" task.

## Gaps

- [x] **CLI connectors emit no `TokensUsed` events.** The default coder
      (`claude`) and the other CLI connectors do not publish token usage, so
      `CostTracker` records nothing and `checkCostBudget` can never trip for a
      CLI-driven run. The per-run USD ceiling is therefore only enforceable for
      API connectors today. Decide whether CLI connectors can report usage
      (some CLIs print token/cost lines) or whether the budget should fall back
      to a wall-clock / turn-count ceiling for CLI seats — and document the
      limitation either way. Extend the `makeCliConnector` seam, not a one-off.

- [x] **The runner hides its `CostTracker`.** `runWithBundle`
      (`packages/runner/src/FlowRunner.ts`) creates a `CostTracker`, consumes
      the hub, and prints a summary, but does not expose the tracker or accept a
      budget. The loop had to attach a _second_ tracker to `bundle.events` just
      to read accrued cost mid-run. Consider a `FlowRunnerOptions.budget` (or
      exposing the tracker on `FlowRunnerBundle`) so consumers can enforce a
      ceiling without duplicating subscription plumbing.

- [x] **No stable identity links a spec's checklist to plan tasks.** Checkbox
      sync (`tools/loop/src/CheckboxSync.ts`) can only map plan completion to
      spec checkboxes positionally, because `planFrom` invents fresh task titles
      unrelated to the spec's `- [ ]` items. A run with different task
      granularity than the spec's checklist syncs approximately. Consider a
      planning path that preserves the source checklist's identity (e.g. plan
      one task per spec checkbox when the spec already carries a task list), so
      bookkeeping is exact rather than heuristic.

## Notes

These are observations, not regressions from pinned `llm4zio` v4.2.0; no ADR or
`docs/parity.md` change is implied yet. If a chosen fix diverges from the pinned
source's cost model, record it there at that time.

## Escalation (run 2, 2026-07-29): positional checkbox sync produces false ticks

Run 2 proved the missing checkbox↔task identity is a correctness bug, not
cosmetics: the plan holds ~10 granular tasks while the spec holds 3 coarse
checkboxes, and the positional sync ticked spec box 2 ("Cover
makeCliConnector…") when plan task 2 (an unrelated, skipped task) completed.
The tick was reverted by hand. Until identities exist, the sync must be
conservative:

- [x] Only sync checkboxes when the plan was generated 1:1 from the spec's
      checklist (same count and order), otherwise leave the spec untouched
      and report progress in the run output instead.
- [x] Longer term: carry a stable identity (e.g. the checkbox text) into
      generated plan tasks so sync can match by identity, not position.

## Completion note (2026-07-29)

The root cause was one level deeper than filed: no code anywhere published
`TokensUsed`, so the cost pipeline was dead for every seat, not just CLI.
Resolution and rationale in ADR 0005 (`docs/adr/0005-cost-events-at-the-chat-
seam.md`): usage events are produced at the Chat seam (and
`completeAndPublish`), connectors without usage now declare
`usageReporting: false` (capability matrix updated), the runner exposes its
tracker on `FlowRunnerBundle` and accepts `FlowRunnerOptions.budget`, and the
loop plans one task per spec-checklist item so checkbox sync is exact 1:1
identity by construction. The harness consumes the runner-side pieces on its
next pin bump (>= 0.1.5).
