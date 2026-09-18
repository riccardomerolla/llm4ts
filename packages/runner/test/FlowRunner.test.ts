import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Fiber from "effect/Fiber"
import * as Ref from "effect/Ref"
import * as Stream from "effect/Stream"
import * as TestClock from "effect/testing/TestClock"
import { ApiConnectorConfig, CliConnectorConfig } from "@llm4ts/core/ConnectorConfig"
import { makeConnectorRegistry } from "@llm4ts/core/ConnectorRegistry"
import { ProviderError } from "@llm4ts/core/Errors"
import { ConnectorIds, LlmChunk, LlmConfig, TokenUsage } from "@llm4ts/core/Models"
import { collect } from "@llm4ts/core/Streaming"
import { makeFakeProcessExecutor, makeProcessExecutor } from "@llm4ts/core/ProcessExecutor"
import * as Queue from "effect/Queue"
import { makeMockProvider } from "@llm4ts/core/providers/MockProvider"
import { Info, StageCompleted, StageStarted, TokensUsed } from "@llm4ts/flow/FlowEvents"
import { CostBudget } from "@llm4ts/flow/CostLedger"
import type { PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import { makeFlowRunnerContext, runWithBundle } from "@llm4ts/runner/FlowRunner"
import { plainTerminalPalette, type TerminalSurface } from "@llm4ts/runner/Terminal"

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
  // A flaky CLI stream (empty response / malformed tool call) used to fail the
  // whole stage: the retry wrapper existed but nothing wired it to a seat.
  it.effect("retries a flaky seat stream and announces every attempt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const process = yield* makeFakeProcessExecutor()
        const state = yield* Ref.make<Readonly<Record<string, string>>>({})
        const attempts = yield* Ref.make(0)
        const flaky = {
          ...makeMockProvider(LlmConfig.make({ provider: "Mock", model: "mock" })),
          executeStream: (_prompt: string) =>
            Stream.unwrap(
              Ref.updateAndGet(attempts, (count) => count + 1).pipe(
                Effect.map((count) =>
                  count === 1
                    ? Stream.fail(
                        ProviderError.make({
                          message: "Invalid stream: The model returned an empty response"
                        })
                      )
                    : Stream.make(LlmChunk.make({ delta: "recovered", finishReason: "stop" }))
                )
              )
            )
        }
        const registry = makeConnectorRegistry([
          { connectorId: ConnectorIds.OpenAI, kind: "Api", create: (_c) => Effect.succeed(flaky) }
        ])

        const bundle = yield* makeFlowRunnerContext(
          {
            workDir: "/repo",
            workspace: "/repo",
            userPrompt: "do it",
            coder: ApiConnectorConfig.make({ connectorId: ConnectorIds.OpenAI })
          },
          { registry, process: process.executor, files: files(state) }
        )
        const recorded: Array<string> = []
        const subscription = yield* bundle.events.subscribe
        yield* Stream.fromSubscription(subscription).pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              if (event._tag === "Info") {
                recorded.push(event.message)
              }
            })
          ),
          Effect.forkScoped
        )

        // The wrapper waits before its fresh retry; advance past that delay.
        const running = yield* Effect.forkChild(collect(bundle.context.coder.executeStream("go")))
        yield* TestClock.adjust("5 seconds")
        const response = yield* Fiber.join(running)
        yield* Effect.yieldNow

        assert.strictEqual(response.content, "recovered")
        assert.strictEqual(yield* Ref.get(attempts), 2)
        assert.isTrue(
          recorded.some((message) => message.includes("⟳ flaky stream (fresh retry) — retry 1/6")),
          `expected a retry notice, saw: ${JSON.stringify(recorded)}`
        )
        // The wrapper must not shadow what the connector carries beyond the
        // service methods — the flow context exposes its capabilities.
        assert.isDefined(bundle.context.coderCapabilities)
      })
    )
  )

  it.effect("prepares API defaults and redacted environment credentials before resolution", () =>
    Effect.gen(function* () {
      const process = yield* makeFakeProcessExecutor()
      const state = yield* Ref.make<Readonly<Record<string, string>>>({})
      const captured = yield* Ref.make<ApiConnectorConfig | undefined>(undefined)
      const mock = makeMockProvider(LlmConfig.make({ provider: "Mock", model: "mock" }))
      const registry = makeConnectorRegistry([
        {
          connectorId: ConnectorIds.OpenAI,
          kind: "Api",
          create: (configuration) =>
            configuration instanceof ApiConnectorConfig
              ? Ref.set(captured, configuration).pipe(Effect.as(mock))
              : Effect.succeed(mock)
        }
      ])

      yield* makeFlowRunnerContext(
        {
          workDir: "/repo",
          workspace: "/repo",
          userPrompt: "do it",
          coder: ApiConnectorConfig.make({
            connectorId: ConnectorIds.OpenAI,
            model: "gpt-test"
          }),
          environment: {
            OPENAI_API_KEY: "secret"
          }
        },
        {
          registry,
          process: process.executor,
          files: files(state)
        }
      )
      const prepared = yield* Ref.get(captured)

      assert.strictEqual(prepared?.baseUrl, "https://api.openai.com/v1")
      assert.strictEqual(
        prepared?.apiKey === undefined ? undefined : Redacted.value(prepared.apiKey),
        "secret"
      )
    })
  )

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
            palette: plainTerminalPalette,
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
          const result = yield* runWithBundle(
            bundle,
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
          assert.isTrue(rendered.some((line) => line.includes("✔ Example (")))
          assert.isTrue(rendered.some((line) => line.includes("cost: no usage reported")))
          assert.isTrue(rendered.some((line) => line.includes("coder mock")))
          assert.isTrue(rendered.some((line) => line.includes("trace trace.jsonl · run run-1")))
          assert.isTrue(
            rendered.some((line) => /flow completed in .+ · 1 stage$/.test(line.trim()))
          )
        })
      )
  )
})

describe("runner cost budget", () => {
  it.effect("exposes the tracker on the bundle and enforces the configured budget", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const process = yield* makeFakeProcessExecutor()
        const state = yield* Ref.make<Readonly<Record<string, string>>>({})
        const mock = makeMockProvider(LlmConfig.make({ provider: "Mock", model: "mock" }))
        const registry = makeConnectorRegistry([
          {
            connectorId: ConnectorIds.Mock,
            kind: "Api",
            create: (_configuration) => Effect.succeed(mock)
          }
        ])
        const surface: TerminalSurface = {
          palette: plainTerminalPalette,
          log: (_line) => Effect.void,
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
          coder: ApiConnectorConfig.make({ connectorId: ConnectorIds.Mock }),
          surface,
          budget: CostBudget.make({ maximumTokens: 10 })
        }

        const bundle = yield* makeFlowRunnerContext(options, dependencies)
        const error = yield* Effect.flip(
          runWithBundle(
            bundle,
            options,
            (context) =>
              context.events.publish(
                TokensUsed.make({
                  agent: "coder",
                  usage: TokenUsage.make({ prompt: 100, completion: 40, total: 140 })
                })
              ),
            dependencies
          )
        )
        const cells = yield* bundle.tracker.cells

        assert.strictEqual(error._tag, "BudgetExceeded")
        assert.isAbove(cells.length, 0)
      })
    )
  )
})

describe("gemini ACP bridge wiring (ADR 0016)", () => {
  const piModelsJson = JSON.stringify({
    providers: {
      "gemini-bridge": {
        baseUrl: "http://127.0.0.1:0",
        api: "anthropic-messages",
        apiKey: "bridge-unused",
        models: [{ id: "gemini-2.5-pro" }]
      }
    }
  })

  /** Records the config each seat was resolved with. */
  const recordingDependencies = (
    seen: Ref.Ref<ReadonlyArray<string | undefined>>,
    state: Ref.Ref<Readonly<Record<string, string>>>,
    stdin: Queue.Queue<string>,
    readPiModelsJson: () => string | undefined
  ) => ({
    registry: makeConnectorRegistry([
      {
        connectorId: ConnectorIds.Pi,
        kind: "Cli" as const,
        create: (config: { readonly model?: string }) =>
          Ref.update(seen, (current) => [...current, config.model]).pipe(
            Effect.as(makeMockProvider(LlmConfig.make({ provider: "Mock", model: "mock" })))
          )
      }
    ]),
    // The bridge spawns `gemini --experimental-acp` over this executor.
    process: makeProcessExecutor({
      run: () => Effect.die("not used"),
      runStreaming: () => Stream.empty,
      runBidirectional: () => Effect.succeed([stdin, Stream.never])
    }),
    files: files(state),
    readPiModelsJson
  })

  const piCoder = CliConnectorConfig.make({ connectorId: ConnectorIds.Pi })

  it.effect("leaves pi alone when the bridge was not requested", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const seen = yield* Ref.make<ReadonlyArray<string | undefined>>([])
        const state = yield* Ref.make<Readonly<Record<string, string>>>({})
        const stdin = yield* Queue.unbounded<string>()
        yield* makeFlowRunnerContext(
          {
            workDir: "/repo",
            workspace: "/repo",
            userPrompt: "do it",
            coder: piCoder,
            environment: {}
          },
          recordingDependencies(seen, state, stdin, () => piModelsJson)
        )
        // No model injected, and nothing spawned.
        assert.deepStrictEqual(yield* Ref.get(seen), [undefined, undefined])
      })
    )
  )

  it.effect("points every pi seat at the bridge model when opted in", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const seen = yield* Ref.make<ReadonlyArray<string | undefined>>([])
        const state = yield* Ref.make<Readonly<Record<string, string>>>({})
        const stdin = yield* Queue.unbounded<string>()
        yield* makeFlowRunnerContext(
          {
            workDir: "/repo",
            workspace: "/repo",
            userPrompt: "do it",
            coder: piCoder,
            environment: { LLM4TS_GEMINI_BRIDGE: "1", LLM4TS_GEMINI_BRIDGE_PORT: "0" }
          },
          recordingDependencies(seen, state, stdin, () => piModelsJson)
        )
        // Coder and the reasoning seat that defaults to it.
        assert.deepStrictEqual(yield* Ref.get(seen), [
          "gemini-bridge/gemini-2.5-pro",
          "gemini-bridge/gemini-2.5-pro"
        ])
      })
    )
  )

  it.effect("keeps a model the caller chose explicitly", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const seen = yield* Ref.make<ReadonlyArray<string | undefined>>([])
        const state = yield* Ref.make<Readonly<Record<string, string>>>({})
        const stdin = yield* Queue.unbounded<string>()
        yield* makeFlowRunnerContext(
          {
            workDir: "/repo",
            workspace: "/repo",
            userPrompt: "do it",
            coder: CliConnectorConfig.make({
              connectorId: ConnectorIds.Pi,
              model: "chosen/by-hand"
            }),
            environment: { LLM4TS_GEMINI_BRIDGE: "1", LLM4TS_GEMINI_BRIDGE_PORT: "0" }
          },
          recordingDependencies(seen, state, stdin, () => piModelsJson)
        )
        assert.deepStrictEqual(yield* Ref.get(seen), ["chosen/by-hand", "chosen/by-hand"])
      })
    )
  )

  // Opting in and leaving pi unable to reach the bridge is the failure this
  // whole feature exists to avoid, so it stops here rather than surfacing as
  // pi's own "No API key found" several layers down.
  it.effect("fails the run when no bridge model can be resolved", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const seen = yield* Ref.make<ReadonlyArray<string | undefined>>([])
        const state = yield* Ref.make<Readonly<Record<string, string>>>({})
        const stdin = yield* Queue.unbounded<string>()
        const result = yield* makeFlowRunnerContext(
          {
            workDir: "/repo",
            workspace: "/repo",
            userPrompt: "do it",
            coder: piCoder,
            environment: { LLM4TS_GEMINI_BRIDGE: "1", LLM4TS_GEMINI_BRIDGE_PORT: "0" }
          },
          recordingDependencies(seen, state, stdin, () => undefined)
        ).pipe(Effect.result)
        assert.strictEqual(result._tag, "Failure")
        assert.include(
          result._tag === "Failure" ? String(result.failure) : "",
          "No usable bridge model"
        )
        // Nothing was resolved, so no pi process could have been started.
        assert.deepStrictEqual(yield* Ref.get(seen), [])
      })
    )
  )
})
