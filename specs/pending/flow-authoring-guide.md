# Flow Authoring Guide

Write `docs/flow-authoring.md`: the missing user-facing guide for authoring
flows, filling the gap between the README quickstart and the reference docs.

Blast radius: docs only. No code changes.

## Tasks

- [x] Ladder structure mirroring the examples: one-shot prompt
      (`runNode` + `completeAndPublish`) → persisted plan
      (`implementPlanFlow`) → custom spine from primitives (`stage`,
      `implementTaskLoop`, `reviewAndFixLoop`, gates — the `examples/sdd.ts`
      pattern).
- [x] Document the seams and their options: `FlowRunnerOptions` (seats,
      verbosity, trace, environment), `ImplementPlanOptions`, review gates
      (`lintCommand`, `format`), events and the terminal surface.
- [x] Testing section: how to test a flow with `makeMemoryPlainFileStore`,
      fake git/hosting tools, and mock `LlmServiceShape` — lifted from
      `packages/flow/test/Flow.test.ts`.
- [x] Every code snippet must typecheck (mirror snippets from real example
      files rather than inventing them).
- [x] Link the guide from `README.md` and `docs/api.md`.

## References

- `packages/flow/src/Flow.ts`, `packages/runner/src/FlowRunner.ts`
- `examples/basic.ts`, `examples/implement.ts`, `examples/sdd.ts`
- `packages/flow/test/Flow.test.ts`

## Completion note (2026-07-29)

Rungs 1–2 written and committed by the dogfood loop (runs 3b); rung 3, the
testing section, and the links finished by hand after run 3c hit a
formatter-vs-sync-test deadlock: prettier reformats TS inside markdown
fences, while the loop's own `examples/test/docs-sync.test.ts` (a
loop-authored regression test pinning doc excerpts to real source files)
required verbatim excerpts. Resolution: excerpts sit in
`<!-- prettier-ignore -->` fences and the sync comparison strips all
whitespace — content is the contract, not layout. Nine sync tests cover the
guide.
