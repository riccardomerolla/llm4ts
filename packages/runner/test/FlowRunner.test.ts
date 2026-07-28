import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import { ApiConnectorConfig } from "@llm4ts/core/ConnectorConfig"
import { makeConnectorRegistry } from "@llm4ts/core/ConnectorRegistry"
import { ConnectorIds, LlmConfig } from "@llm4ts/core/Models"
import { makeFakeProcessExecutor } from "@llm4ts/core/ProcessExecutor"
import { makeMockProvider } from "@llm4ts/core/providers/MockProvider"
import { Info, StageCompleted, StageStarted } from "@llm4ts/flow/FlowEvents"
import type { PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import { makeFlowRunnerContext, runEmbedded } from "@llm4ts/runner/FlowRunner"
import type { TerminalSurface } from "@llm4ts/runner/Terminal"

const files = (state: Ref.Ref<Readonly<Record<string, string>>>): PlainFileStoreShape => ({
  read: (path) => Ref.get(state).pipe(Effect.map((current) => current[path])),
  writeAtomic: (path, value) => Ref.update(state, (current) => ({ ...current, [path]: value })),
  append: (path, value) =>
    Ref.update(state, (current) => ({
      ...current,
      [path]: `${current[path] ?? ""}${value}`
    })),
  remove: (_path) => Effect.void,
  hashSha256: (_path) => Effect.succeed("hash")
})

describe("embedded runner", () => {
  it.effect(
    "builds an injectable context and composes event, trace, terminal, and cost subscribers",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const process = yield* makeFakeProcessExecutor()
          const state = yield* Ref.make<Readonly<Record<string, string>>>({})
          const output = yield* Ref.make<ReadonlyArray<string>>([])
          const mock = makeMockProvider(LlmConfig.make({ provider: "Mock", model: "mock" }))
          const registry = makeConnectorRegistry([
            {
              connectorId: ConnectorIds.Mock,
              kind: "Api",
              create: (_configuration) => Effect.succeed(mock)
            }
          ])
          const coder = ApiConnectorConfig.make({
            connectorId: ConnectorIds.Mock
          })
          const surface: TerminalSurface = {
            log: (line) => Ref.update(output, (current) => [...current, line]),
            setStatus: (_label) => Effect.void,
            suspend: (effect) => effect
          }
          const dependencies = {
            registry,
            process: process.executor,
            files: files(state)
          }
          const options = {
            workDir: "/repo",
            workspace: "/repo",
            userPrompt: "do it",
            coder,
            surface,
            tracePath: "trace.jsonl",
            runId: "run-1"
          }
          const bundle = yield* makeFlowRunnerContext(options, dependencies)
          const result = yield* runEmbedded(
            options,
            (context) =>
              context.events
                .publish(StageStarted.make({ stage: "Example" }))
                .pipe(
                  Effect.andThen(context.events.publish(Info.make({ message: "working" }))),
                  Effect.andThen(context.events.publish(StageCompleted.make({ stage: "Example" }))),
                  Effect.as("done")
                ),
            dependencies
          )
          const trace = (yield* Ref.get(state))["trace.jsonl"] ?? ""
          const rendered = yield* Ref.get(output)

          assert.strictEqual(bundle.context.userPrompt, "do it")
          assert.strictEqual(bundle.context.coderCapabilities.streaming, true)
          assert.strictEqual(result, "done")
          assert.match(trace, /StageStarted/)
          assert.isTrue(rendered.some((line) => line.includes("▶ Example")))
          assert.isTrue(rendered.some((line) => line.includes("By agent:")))
        })
      )
  )
})
