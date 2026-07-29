# Per-Task Chat Policy for implementPlanFlow

`implementPlanFlow` hardwires one `makeChat` across all plan tasks, so long
plans accumulate the full transcript of earlier tasks into every prompt. Ralph
demonstrated the alternative: a fresh context per task, with continuity
carried by durable artifacts (plan, brief) instead of transcripts. The dogfood
loop needs this; any user building a long-running flow will too.

Blast radius: one flow module + tests; additive, default unchanged.

## Tasks

- [x] Add a chat policy to `ImplementPlanOptions` — e.g.
      `chatPerTask?: boolean` (default `false`, preserving current behavior)
      or a `makeCoderChat?: (task: Task) => Effect<Chat>` hook if a single
      boolean proves too rigid. Prefer the smallest interface that covers the
      dogfood-loop case; record the choice in the spec.

      **Decision:** `chatPerTask?: boolean` (default `false`). The only known
      consumer, `tools/loop/src/Loop.ts`, builds its per-task chat today with
      `makeChat(context.coder)` — no system-prompt override, no per-task
      service selection. A boolean covers that fully; a `makeCoderChat` hook
      would add surface area no consumer needs yet. The field is additive
      and currently unwired — `implementPlanFlow` still shares one `Chat`
      across all tasks regardless of its value. Wiring the fresh-chat
      behavior is the next task below.

- [ ] With the policy on: each task gets a fresh `Chat` whose system prompt
      includes the configured `system` plus a compact progress note (plan
      state so far); the task's review-fix rounds share that task's chat.
      Must land together with the tests below in the same change — this task
      introduces real behavior, so it is not done until the coverage bar is
      met. Also: remove or rewrite the `/** Currently unwired ... */` doc
      comment on `chatPerTask` (`packages/flow/src/Flow.ts`) to describe the
      real behavior, and replace (not merely add alongside) the interim
      "chatPerTask is accepted but unwired" test in `Flow.test.ts` — once
      wiring lands, that test's asserted invariant (identical shared-Chat
      growth regardless of `chatPerTask`) is no longer true for
      `chatPerTask: true`.
- [ ] Tests in `packages/flow/test/Flow.test.ts`: with `chatPerTask: true`,
      assert each task gets a fresh `Chat` (e.g. the history/message count
      seen by the LLM resets per task instead of growing across tasks); with
      `chatPerTask: false` or omitted, assert the existing single-shared-Chat
      behavior is unchanged; assert review-fix rounds within one task still
      share that task's chat.
- [ ] Update `docs/api.md` (Flow section) and, once shipped in a release,
      simplify `tools/loop/` to use it.

## References

- `packages/flow/src/Flow.ts`, `packages/flow/src/Chat.ts`
- Ralph context model: `RALPH_AUTO_PROMPT.md` (one task per iteration)
- `specs/pending/dogfood-loop.md` (consumer of this feature)
