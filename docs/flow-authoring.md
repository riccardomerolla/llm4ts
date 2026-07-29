# Flow Authoring Guide

## Who this is for

You've tried the [`@llm4ts/js` quickstart](../README.md#try-it-in-one-minute)
or run `npx llm4ts` from the terminal, and now you want to write a flow
directly against `runNode` — publishing your own events, reaching the
connector's raw streaming API, or composing more than one prompt in a single
Effect program. This guide assumes no prior Effect experience but does assume
you're comfortable reading TypeScript; each call in the walkthrough below is
explained as it appears.

This is example-driven, not a reference. For the full list of exports per
package, see the [API guide](api.md); for how the packages depend on each
other, see [Architecture](architecture.md). Everything here composes only
public subpath exports, the same constraint the [`examples/`](../examples/README.md)
scripts follow.

## The ladder

`examples/` climbs from a mock completion to HTTP providers, CLI coding
agents, persistent resumable plans, and full issue-to-PR automation. This
guide climbs the same ladder in prose, one rung per section. This first rung
covers the simplest flow there is: send one prompt, get one response,
publish it as an event.

## Rung 1: a one-shot prompt flow

This is `examples/basic.ts` verbatim. It runs with no credentials because it
uses the built-in mock connector:

```ts
import * as Effect from "effect/Effect"
import { ApiConnectorConfig } from "@llm4ts/core/ConnectorConfig"
import { ConnectorIds } from "@llm4ts/core/Models"
import { collect } from "@llm4ts/core/Streaming"
import { FlowLlmError } from "@llm4ts/flow/FlowError"
import { AssistantMessage } from "@llm4ts/flow/FlowEvents"
import { runNode } from "@llm4ts/runner/FlowRunner"

const prompt = process.argv.slice(2).join(" ").trim() || "Explain this repository."

const program = runNode(
  {
    workDir: process.cwd(),
    workspace: process.cwd(),
    userPrompt: prompt,
    coder: ApiConnectorConfig.make({
      connectorId: ConnectorIds.Mock
    })
  },
  (context) =>
    collect(context.coder.executeStream(prompt)).pipe(
      Effect.mapError(FlowLlmError.from),
      Effect.tap((response) =>
        context.events.publish(AssistantMessage.make({ text: response.content }))
      ),
      Effect.asVoid
    )
)

Effect.runFork(program)
```

Run it from a built workspace with:

```sh
pnpm --filter @llm4ts/examples basic -- "Draft a small implementation plan"
```

### Walking through each call

- **`ApiConnectorConfig.make({ connectorId: ConnectorIds.Mock })`** — builds a
  connector configuration. `ConnectorIds.Mock` selects the deterministic,
  credential-free connector from the identity table in
  `@llm4ts/core/Models`; swap it for `ConnectorIds.OpenAi`,
  `ConnectorIds.Anthropic`, and friends once you're ready to hit a real
  provider (see `docs/provider-capabilities.md` for what each one supports).
  This value is a plain, serializable config — no Effect layers to assemble.

- **`runNode(options, body)`** — the Node entry point from
  `@llm4ts/runner/FlowRunner`. It wires every Node-specific boundary (HTTP
  client, child processes, temp files, plan persistence, the connector
  registry) and resolves `options.coder` into a live connector before your
  `body` ever runs. `workDir` and `workspace` scope filesystem and git
  access for the flow; `userPrompt` seeds `context.userPrompt` for any node
  in the flow that wants it. `body` receives a `FlowContextShape` — here
  called `context` — carrying the resolved `coder`, an `events` hub, and the
  other flow dependencies.

- **`context.coder.executeStream(prompt)`** — calls the resolved connector
  directly and returns a stream of response chunks rather than a single
  value. Streaming is the connector's native shape; use it when you want to
  render partial output as it arrives.

- **`collect(...)`** — from `@llm4ts/core/Streaming`, drains that chunk
  stream into a single assembled response (content, usage, finish reason).
  Reach for this whenever you just need the final text, as in this example.

- **`Effect.mapError(FlowLlmError.from)`** — normalizes whatever error shape
  the connector or stream produced into `FlowLlmError`, the flow layer's
  typed failure for LLM calls. Every node in a flow is expected to fail with
  a member of `FlowError`, never a bare `Error`, so callers can pattern-match
  on failures instead of catching exceptions.

- **`Effect.tap((response) => context.events.publish(...))`** — runs a side
  effect on success without changing the value flowing through the pipe.
  `context.events` is the flow's event hub; publishing an `AssistantMessage`
  (from `@llm4ts/flow/FlowEvents`) is how a flow node reports the model's
  reply to anything consuming the flow — terminal rendering, trace
  recording, or your own subscriber.

- **`Effect.asVoid`** — discards the response value so the node's return
  type is `void`; this program cares about the publish side effect, not the
  return value.

- **`Effect.runFork(program)`** — executes the assembled Effect as a
  detached fiber. This is the one place in the file anything actually runs;
  everything above it only describes the program.

### The shorter equivalent: `completeAndPublish`

The `collect` → `mapError` → `tap`/`publish` sequence above is common enough
that `@llm4ts/flow/Flow` exports it as `completeAndPublish(service, events,
prompt)`. Swapping it in collapses the body to one call:

```ts
import * as Effect from "effect/Effect"
import { ApiConnectorConfig } from "@llm4ts/core/ConnectorConfig"
import { ConnectorIds } from "@llm4ts/core/Models"
import { completeAndPublish } from "@llm4ts/flow/Flow"
import { runNode } from "@llm4ts/runner/FlowRunner"

const prompt = process.argv.slice(2).join(" ").trim() || "Explain this repository."

const program = runNode(
  {
    workDir: process.cwd(),
    workspace: process.cwd(),
    userPrompt: prompt,
    coder: ApiConnectorConfig.make({
      connectorId: ConnectorIds.Mock
    })
  },
  (context) => completeAndPublish(context.coder, context.events, prompt)
)

Effect.runFork(program)
```

Reach for the explicit `collect`/`mapError`/`tap` form when you need to
inspect the response before publishing, publish a different event, or chain
more work off the result; reach for `completeAndPublish` when a node's whole
job is "ask once, publish the answer."

`examples/api-provider.ts` builds on this same `completeAndPublish` call but
layers on the next rung's concerns, so its shape is different, not just its
connector: it resolves the prompt and workspace via `resolveExampleInput`,
picks a real provider connector via `apiConnectorFromEnvironment`, passes
`environment: process.env` to `runNode` so the connector can read provider
credentials, and drives the whole program through the `runExampleMain`
helper (all three from `examples/support.ts`) instead of a bare
`Effect.runFork`. That's the next rung — see `examples/api-provider.ts` and
the [examples ladder](../examples/README.md).
