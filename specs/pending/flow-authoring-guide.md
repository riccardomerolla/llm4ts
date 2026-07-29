# Flow Authoring Guide

Write `docs/flow-authoring.md`: the missing user-facing guide for authoring
flows, filling the gap between the README quickstart and the reference docs.

Blast radius: docs only. No code changes.

## Tasks

- [ ] Ladder structure mirroring the examples: one-shot prompt
      (`runNode` + `completeAndPublish`) → persisted plan
      (`implementPlanFlow`) → custom spine from primitives (`stage`,
      `implementTaskLoop`, `reviewAndFixLoop`, gates — the `examples/sdd.ts`
      pattern).
- [ ] Document the seams and their options: `FlowRunnerOptions` (seats,
      verbosity, trace, environment), `ImplementPlanOptions`, review gates
      (`lintCommand`, `format`), events and the terminal surface.
- [ ] Testing section: how to test a flow with `makeMemoryPlainFileStore`,
      fake git/hosting tools, and mock `LlmServiceShape` — lifted from
      `packages/flow/test/Flow.test.ts`.
- [ ] Every code snippet must typecheck (mirror snippets from real example
      files rather than inventing them).
- [ ] Link the guide from `README.md` and `docs/api.md`.

## References

- `packages/flow/src/Flow.ts`, `packages/runner/src/FlowRunner.ts`
- `examples/basic.ts`, `examples/implement.ts`, `examples/sdd.ts`
- `packages/flow/test/Flow.test.ts`
