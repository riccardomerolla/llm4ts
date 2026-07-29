# Per-Task Chat Policy for implementPlanFlow

`implementPlanFlow` hardwires one `makeChat` across all plan tasks, so long
plans accumulate the full transcript of earlier tasks into every prompt. Ralph
demonstrated the alternative: a fresh context per task, with continuity
carried by durable artifacts (plan, brief) instead of transcripts. The dogfood
loop needs this; any user building a long-running flow will too.

Blast radius: one flow module + tests; additive, default unchanged.

## Tasks

- [ ] Add a chat policy to `ImplementPlanOptions` — e.g.
      `chatPerTask?: boolean` (default `false`, preserving current behavior)
      or a `makeCoderChat?: (task: Task) => Effect<Chat>` hook if a single
      boolean proves too rigid. Prefer the smallest interface that covers the
      dogfood-loop case; record the choice in the spec.
- [ ] With the policy on: each task gets a fresh `Chat` whose system prompt
      includes the configured `system` plus a compact progress note (plan
      state so far); the task's review-fix rounds share that task's chat.
- [ ] Tests in `packages/flow/test/Flow.test.ts`: transcripts do not leak
      across tasks when enabled; default behavior unchanged; review rounds
      still share the task chat.
- [ ] Update `docs/api.md` (Flow section) and, once shipped in a release,
      simplify `tools/loop/` to use it.

## References

- `packages/flow/src/Flow.ts`, `packages/flow/src/Chat.ts`
- Ralph context model: `RALPH_AUTO_PROMPT.md` (one task per iteration)
- `specs/pending/dogfood-loop.md` (consumer of this feature)
