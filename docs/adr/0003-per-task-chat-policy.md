# ADR 0003: Per-Task Chat Policy As A Boolean Option

## Status

Accepted.

## Context

`implementPlanFlow` originally shared one `Chat` across every plan task, so
long plans fed each task the full transcript of all earlier tasks. The Ralph
loop model demonstrated that fresh context per task — with continuity carried
by durable artifacts (the persisted plan) rather than transcripts — keeps
long runs coherent. The spec allowed either a `chatPerTask?: boolean` or a
`makeCoderChat?: (task) => Effect<Chat>` hook.

## Decision

`chatPerTask?: boolean`, default `false` (preserving existing behavior). The
only known consumer, the dogfood loop harness, builds its per-task chat with
`makeChat(context.coder)` and no per-task variation — a boolean covers that
fully, and a hook would add surface area no consumer needs yet. When enabled,
each task's fresh chat carries the configured `system` prompt plus the
current plan render (prior tasks' completion state) as its progress note, and
the task's review-fix rounds share that task's chat.

This decision was drafted by the dogfood loop's coder during run 4 and is
recorded here rather than in the spec, per ADR 0004.

## Consequences

- Long plans no longer accumulate transcripts across tasks when the policy
  is on; continuity comes from the plan file.
- If a future consumer needs per-task system prompts or per-task service
  selection, introduce the `makeCoderChat` hook alongside the boolean at
  that point — not before.
- The dogfood harness can replace its hand-rolled per-task chat with
  `implementPlanFlow(..., { chatPerTask: true })` once the option ships in a
  published release.
