# Pull-model story context over MCP

Serve the code graph and the orientation digest as MCP tools a coder seat
can call, so a story pulls the view it needs instead of receiving a capped
paste; off by default, measured on the light fixture before it becomes the
default. ADR 0040; item 10 of `docs/research/rea-gap-analysis.md`
section 6. Depends on `harness-evals-pass-predicate.md`.

Driver: story context is pushed under character budgets (ADR 0025); the
graph (ADR 0030) answers only from the terminal; `McpServer.ts` already
serves `ask_user` and `approve` to every harness that takes an MCP
configuration.

## Decisions (ADR 0040)

| Decision | Choice                                                                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tools    | `graph_query`, `graph_path`, `graph_closure`, `orientation`, with `inputSchema` and `outputSchema`, over `GraphQuery.ts` and `Orientation.ts`.               |
| Server   | The existing stdio server in `McpServer.ts`; the tool set is a layer the epic-stories flow adds when the knob is on.                                         |
| Knob     | Roster-level `context: push \| pull` (default `push`); `pull` applies to seats whose harness takes an MCP configuration; API seats keep `push`.              |
| Prompt   | Under `pull`, the orientation summary stays; readFirst closure and graph neighbourhood are replaced by one paragraph naming the tools and when to call them. |
| Default  | Flips to `pull` only when `profile --check` passes and `profile --against` shows fewer prompt characters or explore calls per story on two harnesses.        |
| Budget   | Tool results pass through `cap` from `Context.ts` with the same visible truncation as the paste.                                                             |

## Modules

- `packages/flow/src/McpServer.ts`: `outputSchema` support; the four tools
  as a `McpTool[]` factory taking the graph and orientation inputs.
- `packages/flow/src/Stories.ts` and the epic-stories flow: the knob, the
  prompt variant, the server layer.
- `packages/runner/src/ExecutorRoster.ts`: `context` field.
- `docs/harness-evals/`: the before-and-after profiles and `--check`
  output for the flip.

## Tasks

- [ ] `outputSchema` in `tools/list`; snapshot test.
- [ ] The four tools over the memory graph fixture; one test per tool
      including the truncation path.
- [ ] Roster knob parsed and validated; prompt variant snapshot.
- [ ] Light-fixture measurement on two harnesses recorded in
      `docs/harness-evals/`; CHANGELOG with the tuned-on model line.
- [ ] Default flip as a separate PR citing the measurement.
- [ ] `docs/flow-authoring.md`, `docs/configuration.md`, `docs/parity.md`
      additive note.

## Tests

Deterministic: `tools/list` and `tools/call` over the in-memory graph;
prompt rendering under both knob values.

## Non-goals

Serving rea or any external MCP server; tools that write; changing the
API-seat prompt.
