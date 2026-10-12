# Dogfood Loop: llm4ts develops llm4ts

Build a Ralph-style autonomous dev loop whose engine is llm4ts itself. The
goal is a **forcing function** to find library gaps, not a replacement:
`ralph-auto.sh` stays as the fallback until the loop has completed three specs
end-to-end unattended.

## Decisions (agreed 2026-07-29)

| Decision       | Choice                                                                                                                                                                                                                                                                        |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Goal           | Forcing function with fallback; every friction point becomes a spec in `specs/pending/`.                                                                                                                                                                                      |
| Trust boundary | Runtime-owned Git: the flow commits per task after gates pass. `git.checkpoint` before each task, `rollback` on failure. The loop never pushes.                                                                                                                               |
| Context        | Fresh `Chat` per task (Ralph parity); continuity via the persisted Plan and a compact progress note in the system prompt, not transcripts.                                                                                                                                    |
| Bootstrap      | Stable-compiler model: harness lives in `tools/loop/` with its own package.json and lockfile, pinned to the latest **published** `@llm4ts/*`. Upgrading the pin is a deliberate act after a release.                                                                          |
| Unit of work   | One spec per run: `loop <specs/pending/foo.md>`. `planFrom(reasoning, spec)` → Plan persisted under `.llm4ts/`, resumable via `recoverOrCreate`. No plan mutation by the loop in v1.                                                                                          |
| Bookkeeping    | The harness syncs `- [x]` checkboxes into the spec deterministically from plan state. The LLM never edits specs.                                                                                                                                                              |
| Seats          | `coderFromEnv` (`LLM4TS_CODER`, default claude); reasoning/reviewer are the derived read-only coder; `minimalReviewers` + CI lint gate. Fully unattended: no Interaction/approval wiring in v1.                                                                               |
| CI gate        | `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` as the `lint` gate inside `reviewAndFixLoop`; commit only when green.                                                                                                                                         |
| Failure        | Fail fast: exhausted review rounds → rollback to checkpoint, print gate output + trace path, exit non-zero. Re-run resumes at the failed task with a fresh chat.                                                                                                              |
| Formatter      | The CSP "formatter step": `pnpm format` runs best-effort before each review round (`LLM4TS_LOOP_FORMAT`). The headless coder cannot run commands, so deterministic formatting is the flow's job — run 3 failed a docs-only task by asking the model to hand-imitate prettier. |
| Guardrails     | Per-run cost budget (default $5, overridable) via `CostTracker`/`BudgetExceeded`; per-task `turnLimit` honored.                                                                                                                                                               |
| Trust bar      | Three specs completed end-to-end unattended before the loop takes over any of Ralph's duties.                                                                                                                                                                                 |

## Tasks

- [x] Scaffold `tools/loop/` (own package.json + lockfile, depends on published
      `@llm4ts/runner`/`@llm4ts/flow`/`@llm4ts/core` at the latest release; not
      part of the pnpm workspace).
- [x] Implement the harness: spec path argument → `resolveFlowInput`-style
      parsing → `runNode` with `coderFromEnv` → plan via `planFrom` +
      `makePlanStore.recoverOrCreate` → per-task: checkpoint, fresh
      `makeChat`, `coder.ask(taskPrompt)`, `reviewAndFixLoop` with the CI
      lint gate, `commitAll`, rollback on failure.
- [x] Deterministic checkbox sync: after the run, update `- [ ]`/`- [x]` in
      the focus spec from plan state (plain code, no LLM).
- [x] Cost budget and turn-limit wiring; trace always written under
      `.llm4ts/`; cost summary printed on exit.
- [x] A `--dry-run` mode that plans and prints tasks without executing.
- [x] README in `tools/loop/` documenting usage and the trust bar.
- [x] Record every library gap discovered during implementation as a new spec
      in `specs/pending/` (see `loop-cost-observability-gaps.md`).

## Non-goals (v1)

Multi-spec self-selection, plan mutation mid-run, approval/Interaction wiring,
push/PR automation, replacing `ralph-auto.sh`.
