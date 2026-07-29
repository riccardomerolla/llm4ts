# Architecture Orientation

Read these before implementing anything non-trivial:

- Package graph and rules: `CLAUDE.md` (root)
- Full architecture guide: `docs/architecture.md`
- Public API by package: `docs/api.md`
- Provider/connector capability matrix: `docs/provider-capabilities.md`
- Behavioral contracts: `docs/csp/` (03-behaviors, 05-effects-and-errors are
  the most load-bearing)
- Source parity: `docs/parity.md` maps every module to the pinned `llm4zio`
  v4.2.0 source; intentional divergences live in `docs/adr/`

## Seams to extend (do not build parallel one-offs)

- API providers: `makeApiConnector` in `packages/core/src/Connector.ts`
- CLI coding agents: `makeCliConnector` + `versionProbe` in the same module
- Connector identity (id ↔ provider ↔ default base URL): the table in
  `packages/core/src/Models.ts`
- Flow spine (plan → branch → per-task coder/review/commit):
  `implementPlanFlow` in `packages/flow/src/Flow.ts`
- Node composition edge: `runNode`/`runEmbedded` in
  `packages/runner/src/FlowRunner.ts` — the runner stays thin; policy belongs
  in core/flow
- Deterministic test fakes: core ships them in `src` (fake process executor,
  recording HTTP client), flow ships `makeMemoryPlainFileStore` and
  `makeMemoryWorkspace`
