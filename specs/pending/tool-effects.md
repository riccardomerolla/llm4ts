# Effects on llm4ts's own tools

Let a tool declare what it does, not only what it needs: an `effects`
record on `ToolDescriptor` with defaults, MCP `readOnlyHint` and
`destructiveHint` derived from it in `McpServer.ts`, and
`Activity.toolCategory` consulting declared effects before falling back to
tool names. Item 6 of `docs/research/rea-gap-analysis.md` section 6; parity
note, no ADR.

Driver: `ToolDescriptor` has `sandbox` and `requires` (`Tool.ts`), which
say what a tool may touch, not whether a call writes, launches, reaches
the network or discards data; the MCP bridge advertises tools with no
hints; `CoderPolicy` and `Activity.ts` classify by name.

## Decisions

| Decision | Choice                                                                                                                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shape    | `ToolEffects { writesWorkspace, launchesProcess, accessesNetwork, mayDiscardData, idempotent }`, all booleans, closed vocabulary, true-only semantics (absent means false, `idempotent` defaults true). |
| Defaults | Derived from `sandbox` when `effects` is absent: `WorkspaceReadWrite` implies `writesWorkspace`; `Unrestricted` implies `launchesProcess` and `accessesNetwork`; `WorkspaceReadOnly` implies none.      |
| MCP      | `toolsListResult` emits `annotations: { readOnlyHint, destructiveHint, idempotentHint, openWorldHint }` from the effects; `ask_user` and `approve` declare theirs.                                      |
| Activity | `toolCategory(tool, args, effects?)` uses effects when the harness tool is one llm4ts served; names remain the fallback for a harness's built-in tools.                                                 |
| Guard    | `CapabilityGuard` is unchanged; effects describe, capabilities authorize.                                                                                                                               |

## Modules

- `packages/core/src/tools/Tool.ts`: `ToolEffects` schema, field on
  `ToolDescriptor`, `ToolOptions.effects`, `effectsOf(descriptor)` with the
  defaults.
- `packages/flow/src/McpServer.ts`: annotations in `toolsListResult`.
- `packages/flow/src/Activity.ts`: optional effects argument.
- Built-in tools under `packages/core/src/tools/` and `packages/flow/src/*Tool.ts`
  declare effects where the default is wrong (a `GitTool` push accesses the
  network; a workspace delete `mayDiscardData`).

## Tasks

- [ ] Schema, defaults and `effectsOf`; decode test for a descriptor
      without the field.
- [ ] MCP annotations; a `tools/list` snapshot test.
- [ ] `toolCategory` with effects; existing activity tests unchanged plus
      one for a served tool.
- [ ] Built-in tools reviewed and declared; one assertion each.
- [ ] `docs/api.md` tools section, `docs/parity.md` additive note,
      CHANGELOG.

## Tests

Pure: defaults per sandbox; a tool declaring `mayDiscardData` lists
`destructiveHint: true`; `toolCategory` returns `edit` for a served tool
with `writesWorkspace` regardless of its name.

## Non-goals

An effects audit of harness built-in tools; enforcing effects at runtime;
changing `sandbox` or `requires`.
