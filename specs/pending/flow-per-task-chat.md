# Per-Task Chat Policy for implementPlanFlow

`implementPlanFlow` hardwires one `makeChat` across all plan tasks, so long
plans accumulate the full transcript of earlier tasks into every prompt. Ralph
demonstrated the alternative: a fresh context per task, with continuity
carried by durable artifacts (plan, brief) instead of transcripts. The dogfood
loop needs this; any user building a long-running flow will too.

Blast radius: one flow module + tests; additive, default unchanged.

## Tasks

- [x] Add a chat policy to `ImplementPlanOptions` — the smallest interface
      that covers the dogfood-loop case (see ADR 0003 for the decision).
- [x] With the policy on: each task gets a fresh `Chat` whose system prompt
      includes the configured `system` plus a compact progress note (plan
      state so far); the task's review-fix rounds share that task's chat.
- [x] Tests in `packages/flow/test/Flow.test.ts`: with `chatPerTask: true`,
      assert each task gets a fresh `Chat`; with `chatPerTask: false` or
      omitted, assert the existing single-shared-Chat behavior is unchanged;
      assert review-fix rounds within one task still share that task's chat.
- [x] Update `docs/api.md` (Flow section).
- [x] Once shipped in a release, simplify `tools/loop/` to use it.

## References

- `packages/flow/src/Flow.ts`, `packages/flow/src/Chat.ts`
- Ralph context model: `RALPH_AUTO_PROMPT.md` (one task per iteration)
- `specs/pending/dogfood-loop.md` (consumer of this feature)
- ADR 0003 (`docs/adr/0003-per-task-chat-policy.md`)
