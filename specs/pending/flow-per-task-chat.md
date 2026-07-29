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

- [x] With the policy on: each task gets a fresh `Chat` whose system prompt
      includes the configured `system` plus a compact progress note (plan
      state so far); the task's review-fix rounds share that task's chat.
      Wired in `implementPlanFlow` (`packages/flow/src/Flow.ts`): a
      `Ref<Plan>` tracks progress, and `chatPerTask: true` builds a fresh
      `Chat` per task (system = configured `system` + `plan.render` of the
      progress so far) that is reused for the task's initial ask and
      its `reviewAndFixLoop` fix rounds. The doc comment on `chatPerTask` was
      rewritten to describe this, and the interim "accepted but unwired" test
      was replaced (see below).
- [x] Tests in `packages/flow/test/Flow.test.ts`: with `chatPerTask: true`,
      assert each task gets a fresh `Chat` (e.g. the history/message count
      seen by the LLM resets per task instead of growing across tasks); with
      `chatPerTask: false` or omitted, assert the existing single-shared-Chat
      behavior is unchanged; assert review-fix rounds within one task still
      share that task's chat. Two tests now cover this: "chatPerTask false or
      omitted: one Chat is shared across every task" and "chatPerTask true:
      each task gets a fresh Chat, but its review-fix rounds share it" (the
      latter uses a reviewer that reports one issue only on its first call, to
      force exactly one fix round, and asserts the history-length sequence
      `[2, 4, 2]`).
- [x] Update `docs/api.md` (Flow section). Done in `854258d`.
- [ ] Once shipped in a release, simplify `tools/loop/` to use it: replace the
      hand-rolled `perTask` loop in `tools/loop/src/Loop.ts:231-283` (git
      checkpoint → `makeChat(context.coder)` → `ask` → `reviewAndFixLoop` →
      gate check → commit → cost-budget check, with the whole attempt rolled
      back to that checkpoint on error) with `implementPlanFlow`
      called with `chatPerTask: true`. **Blocked:** the `chatPerTask` commits
      (`32d607f`, `d3fe79d`, `854258d`) landed after the `v0.1.3` tag — no
      release includes this feature yet. Package versions are still `0.1.3`,
      matching the tag, so nothing has been bumped for the next release.

## References

- `packages/flow/src/Flow.ts`, `packages/flow/src/Chat.ts`
- Ralph context model: `RALPH_AUTO_PROMPT.md` (one task per iteration)
- `specs/pending/dogfood-loop.md` (consumer of this feature)
