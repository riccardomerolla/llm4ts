import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Fiber from "effect/Fiber"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as TestClock from "effect/testing/TestClock"
import { ApiConnectorConfig, CliConnectorConfig } from "@llm4ts/core/ConnectorConfig"
import { makeConnectorRegistry } from "@llm4ts/core/ConnectorRegistry"
import type { ConnectorShape } from "@llm4ts/core/Connector"
import { ProviderError } from "@llm4ts/core/Errors"
import {
  ConnectorIds,
  LabelDistribution,
  LlmChunk,
  LlmConfig,
  TokenUsage
} from "@llm4ts/core/Models"
import { collect } from "@llm4ts/core/Streaming"
import { makeFakeProcessExecutor, makeProcessExecutor } from "@llm4ts/core/ProcessExecutor"
import * as Queue from "effect/Queue"
import { makeMockProvider } from "@llm4ts/core/providers/MockProvider"
import { makeRecordingHttpClient } from "@llm4ts/core/HttpClient"
import { choiceOf, truthOf } from "@llm4ts/core/judgment/Judgment"
import { choice, truth, truthAnswer, origins } from "@llm4ts/core/judgment/Schemas"
import {
  Info,
  JudgmentObserved,
  StageCompleted,
  StageStarted,
  TokensUsed
} from "@llm4ts/flow/FlowEvents"
import { CostBudget, loadCostLedger } from "@llm4ts/flow/CostLedger"
import { completeAndPublish } from "@llm4ts/flow/Flow"
import { makeMemoryPlainFileStore, type PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import { JudgmentObservation, judgmentLogPath } from "@llm4ts/flow/JudgmentLog"
import { TraceLine } from "@llm4ts/flow/FlowRecorder"
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

describe("runner cost ledger", () => {
  const setup = Effect.gen(function* () {
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
    const dependencies = { registry, process: process.executor, files: files(state) }
    const options = {
      workDir: "/repo",
      workspace: "/repo",
      userPrompt: "  budget   this\nrun",
      coder: ApiConnectorConfig.make({ connectorId: ConnectorIds.Mock }),
      surface,
      runId: "run-7",
      costLedgerPath: "/repo/.llm4ts/costs.jsonl"
    }
    return { state, dependencies, options }
  })

  it.effect("appends one record per run that accrued usage, stamped with the run start", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { state, dependencies, options } = yield* setup
        yield* TestClock.setTime(Date.parse("2026-09-18T09:10:00Z"))
        const bundle = yield* makeFlowRunnerContext(options, dependencies)
        yield* runWithBundle(
          bundle,
          options,
          (context) =>
            context.events.publish(StageStarted.make({ stage: "Plan" })).pipe(
              Effect.andThen(
                context.events.publish(
                  TokensUsed.make({
                    agent: "coder",
                    model: "claude-sonnet-4",
                    usage: TokenUsage.make({ prompt: 100, completion: 40, total: 140 })
                  })
                )
              ),
              Effect.andThen(context.events.publish(StageCompleted.make({ stage: "Plan" })))
            ),
          dependencies
        )
        const records = yield* loadCostLedger(dependencies.files, options.costLedgerPath)
        const contents = (yield* Ref.get(state))[options.costLedgerPath] ?? ""

        assert.strictEqual(records.length, 1)
        assert.strictEqual(records[0]?.runId, "run-7")
        assert.strictEqual(records[0]?.at, "2026-09-18T09:10:00.000Z")
        assert.strictEqual(records[0]?.repo, "/repo")
        assert.strictEqual(records[0]?.promptHead, "budget this run")
        assert.strictEqual(records[0]?.totalPrompt, 100)
        assert.strictEqual(records[0]?.totalCompletion, 40)
        assert.deepStrictEqual(
          records[0]?.cells.map((cell) => [cell.stage, cell.agent, cell.model]),
          [["Plan", "coder", "claude-sonnet-4"]]
        )
        assert.strictEqual(contents.split("\n").filter((line) => line.length > 0).length, 1)
      })
    )
  )

  it.effect("records the trace and the ledger under workDir/.llm4ts by default", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { state, dependencies, options: withPaths } = yield* setup
        const { costLedgerPath: _ledger, ...options } = withPaths
        yield* TestClock.setTime(1_700_000_000_000)
        const bundle = yield* makeFlowRunnerContext(options, dependencies)
        yield* runWithBundle(
          bundle,
          options,
          (context) =>
            context.events.publish(
              TokensUsed.make({
                agent: "coder",
                usage: TokenUsage.make({ prompt: 1, completion: 1, total: 2 })
              })
            ),
          dependencies
        )
        const written = Object.keys(yield* Ref.get(state)).sort()

        assert.deepStrictEqual(written, [
          "/repo/.llm4ts/costs.jsonl",
          "/repo/.llm4ts/trace-1700000000000.jsonl"
        ])
      })
    )
  )

  it.effect("leaves no files behind when persistRun is off", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { state, dependencies, options: withPaths } = yield* setup
        const { costLedgerPath: _ledger, ...options } = { ...withPaths, persistRun: false }
        const bundle = yield* makeFlowRunnerContext(options, dependencies)
        yield* runWithBundle(
          bundle,
          options,
          (context) =>
            context.events.publish(
              TokensUsed.make({
                agent: "coder",
                usage: TokenUsage.make({ prompt: 1, completion: 1, total: 2 })
              })
            ),
          dependencies
        )

        assert.deepStrictEqual(Object.keys(yield* Ref.get(state)), [])
      })
    )
  )

  it.effect("writes nothing for a run whose backend reported no usage", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { state, dependencies, options } = yield* setup
        const bundle = yield* makeFlowRunnerContext(options, dependencies)
        yield* runWithBundle(
          bundle,
          options,
          (context) => context.events.publish(Info.make({ message: "quiet" })),
          dependencies
        )

        assert.strictEqual((yield* Ref.get(state))[options.costLedgerPath], undefined)
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

describe("judgment seat", () => {
  const mock = makeMockProvider(LlmConfig.make({ provider: "Mock", model: "mock" }))
  const registryCounting = (created: Ref.Ref<ReadonlyArray<string>>) =>
    makeConnectorRegistry([
      {
        connectorId: ConnectorIds.Mock,
        kind: "Api",
        create: (configuration) =>
          Ref.update(created, (all) => [...all, configuration.model ?? "default"]).pipe(
            Effect.as(mock)
          )
      }
    ])
  const baseOptions = {
    workDir: "/repo",
    workspace: "/repo",
    userPrompt: "do it",
    coder: ApiConnectorConfig.make({ connectorId: ConnectorIds.Mock, model: "coder" })
  }

  it.effect("defaults to the reasoning seat and answers through the mock's label scoring", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const process = yield* makeFakeProcessExecutor()
        const state = yield* Ref.make<Readonly<Record<string, string>>>({})
        const created = yield* Ref.make<ReadonlyArray<string>>([])
        const bundle = yield* makeFlowRunnerContext(baseOptions, {
          registry: registryCounting(created),
          process: process.executor,
          files: files(state)
        })
        // coder + reasoning only: no third resolution for the judgment seat.
        assert.deepStrictEqual(yield* Ref.get(created), ["coder", "coder"])
        assert.strictEqual(bundle.context.judgment?.backend, "llm")
        const result = yield* bundle.context.judgment!.judge({
          state: "s",
          questions: { pick: choice("which?", { a: "first", b: "second" }) }
        })
        const answer = yield* choiceOf(result, "pick")
        assert.strictEqual(answer.choice, "a")
        assert.strictEqual(answer.origin.method, "verbalized")
        assert.strictEqual(bundle.context.judgment?.identity, "llm:mock:coder")
      })
    )
  )

  it.effect("resolves an explicit judgment seat and meters its usage as agent 'judgment'", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const process = yield* makeFakeProcessExecutor()
        const state = yield* Ref.make<Readonly<Record<string, string>>>({})
        const created = yield* Ref.make<ReadonlyArray<string>>([])
        const bundle = yield* makeFlowRunnerContext(
          {
            ...baseOptions,
            judgment: ApiConnectorConfig.make({ connectorId: ConnectorIds.Mock, model: "tiny" })
          },
          { registry: registryCounting(created), process: process.executor, files: files(state) }
        )
        assert.deepStrictEqual(yield* Ref.get(created), ["coder", "coder", "tiny"])
        assert.strictEqual(bundle.context.judgment?.backend, "llm")
      })
    )
  )

  it.effect("selects the hosted backend from the environment and refuses without a key", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const process = yield* makeFakeProcessExecutor()
        const state = yield* Ref.make<Readonly<Record<string, string>>>({})
        const created = yield* Ref.make<ReadonlyArray<string>>([])
        const http = yield* makeRecordingHttpClient(() =>
          Effect.succeed(
            JSON.stringify({
              model: "jev-1.13.0",
              answers: { pick: { type: "noul", noul: 0.8 } },
              usage: { input_tokens: 10, output_tokens: 2 }
            })
          )
        )
        const bundle = yield* makeFlowRunnerContext(
          {
            ...baseOptions,
            environment: { LLM4TS_JUDGMENT_BACKEND: "typesafe", TYPESAFE_API_KEY: "k" }
          },
          {
            registry: registryCounting(created),
            process: process.executor,
            files: files(state),
            http: http.client
          }
        )
        assert.strictEqual(bundle.context.judgment?.backend, "typesafe")
        const subscription = yield* bundle.events.subscribe
        const result = yield* bundle.context.judgment!.judge({
          state: "s",
          questions: { pick: truth("is it?") }
        })
        assert.strictEqual((yield* truthOf(result, "pick")).truth, 0.8)
        const usage = yield* Stream.fromSubscription(subscription).pipe(
          Stream.filter((event) => event instanceof TokensUsed),
          Stream.take(1),
          Stream.runCollect
        )
        const [metered] = usage
        assert.isTrue(metered instanceof TokensUsed && metered.agent === "judgment")

        const refused = yield* Effect.flip(
          makeFlowRunnerContext(
            { ...baseOptions, judgmentBackend: "typesafe", environment: {} },
            { registry: registryCounting(created), process: process.executor, files: files(state) }
          )
        )
        assert.match(String(refused), /TYPESAFE_API_KEY/)
      })
    )
  )
})

describe("judgment observation logging", () => {
  for (const enabled of [undefined, false, true]) {
    it.effect(`attaches only when enabled (${String(enabled)}) and drains before returning`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const memory = yield* makeMemoryPlainFileStore()
          const process = yield* makeFakeProcessExecutor()
          const mock = makeMockProvider(LlmConfig.make({ provider: "Mock", model: "mock" }))
          const registry = makeConnectorRegistry([
            {
              connectorId: ConnectorIds.Mock,
              kind: "Api",
              create: () => Effect.succeed(mock)
            }
          ])
          const dependencies = { registry, process: process.executor, files: memory.store }
          const surface: TerminalSurface = {
            palette: plainTerminalPalette,
            log: () => Effect.void,
            setStatus: () => Effect.void,
            suspend: (effect) => effect
          }
          const options = {
            workDir: "/repo",
            workspace: "/repo",
            userPrompt: "task",
            coder: ApiConnectorConfig.make({ connectorId: ConnectorIds.Mock }),
            environment: {},
            surface,
            ...(enabled === undefined ? {} : { judgmentLog: enabled }),
            ...(enabled === true ? { tracePath: "/repo/trace.jsonl" } : {})
          }
          const bundle = yield* makeFlowRunnerContext(options, dependencies)
          assert.strictEqual(bundle.judgmentLog !== undefined, enabled === true)
          const event = JudgmentObserved.make({
            consumer: "satisfied-probe",
            key: "satisfied",
            state: "reply",
            question: truth("Satisfied?"),
            answer: truthAnswer(1, origins.fake()),
            judgmentIdentity: "fake",
            decision: "act",
            certainty: 1,
            support: 1,
            origin: origins.fake(),
            outcome: { _tag: "SatisfiedProbe", literalMatch: true },
            mode: "observe"
          })
          // Two observations inside the run: the log subscriber was attached
          // when the context was created, before any of them.
          yield* runWithBundle(
            bundle,
            options,
            (context) =>
              context.events.publish(event).pipe(Effect.andThen(context.events.publish(event))),
            dependencies
          )
          const stored = yield* memory.files
          if (enabled === true) {
            const records = yield* Effect.forEach(
              (stored[judgmentLogPath("/repo", event.consumer)] ?? "").trimEnd().split("\n"),
              (line) => Schema.decodeUnknownEffect(Schema.fromJsonString(JudgmentObservation))(line)
            )
            assert.strictEqual(records.length, 2)
            assert.deepStrictEqual(
              records.map((record) => record.runId),
              [bundle.runId, bundle.runId]
            )
            const trace = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(TraceLine))(
              (stored["/repo/trace.jsonl"] ?? "").split("\n")[0] ?? ""
            )
            assert.strictEqual(trace.runId, bundle.runId)
          } else {
            // The run still leaves its default trace; only the judgment log is absent.
            assert.deepStrictEqual(
              Object.keys(stored).filter((path) => !path.includes("/trace-")),
              []
            )
          }
        })
      )
    )
  }

  it.effect("drains when the context scope closes without runWithBundle", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      yield* Effect.scoped(
        Effect.gen(function* () {
          const process = yield* makeFakeProcessExecutor()
          const mock = makeMockProvider(LlmConfig.make({ provider: "Mock", model: "mock" }))
          const bundle = yield* makeFlowRunnerContext(
            {
              workDir: "/repo",
              workspace: "/repo",
              userPrompt: "task",
              runId: "explicit-run",
              coder: ApiConnectorConfig.make({ connectorId: ConnectorIds.Mock }),
              environment: {},
              judgmentLog: true
            },
            {
              registry: makeConnectorRegistry([
                {
                  connectorId: ConnectorIds.Mock,
                  kind: "Api",
                  create: () => Effect.succeed(mock)
                }
              ]),
              process: process.executor,
              files: memory.store
            }
          )
          yield* bundle.events.publish(
            JudgmentObserved.make({
              consumer: "satisfied-probe",
              key: "satisfied",
              state: "reply",
              question: truth("Satisfied?"),
              answer: truthAnswer(1, origins.fake()),
              judgmentIdentity: "fake",
              decision: "act",
              certainty: 1,
              support: 1,
              origin: origins.fake(),
              outcome: { _tag: "SatisfiedProbe", literalMatch: true },
              mode: "observe"
            })
          )
        })
      )
      const record = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(JudgmentObservation))(
        ((yield* memory.files)[judgmentLogPath("/repo", "satisfied-probe")] ?? "").trimEnd()
      )
      assert.strictEqual(record.runId, "explicit-run")
    })
  )
})

// Lifting `EstimatedUsage` into the runner: before this, a seat whose backend
// reports no token counts left the run with no `TokensUsed` at all, so its
// cost summary, its ledger record, and `llm4ts costs` were all empty unless
// the flow itself remembered to wrap its seats.
describe("seat usage metering", () => {
  const mock = () => makeMockProvider(LlmConfig.make({ provider: "Mock", model: "mock" }))
  const noEnvironment: Readonly<Record<string, string | undefined>> = {}

  const setupWith = (service: ConnectorShape) =>
    Effect.gen(function* () {
      const process = yield* makeFakeProcessExecutor()
      const state = yield* Ref.make<Readonly<Record<string, string>>>({})
      const registry = makeConnectorRegistry([
        {
          connectorId: ConnectorIds.Mock,
          kind: "Api" as const,
          create: (_c) => Effect.succeed(service)
        }
      ])
      const surface: TerminalSurface = {
        palette: plainTerminalPalette,
        log: (_line) => Effect.void,
        setStatus: (_label) => Effect.void,
        suspend: (effect) => effect
      }
      return {
        state,
        dependencies: { registry, process: process.executor, files: files(state) },
        options: {
          workDir: "/repo",
          workspace: "/repo",
          userPrompt: "meter this run",
          coder: ApiConnectorConfig.make({ connectorId: ConnectorIds.Mock }),
          surface,
          runId: "run-meter",
          persistRun: false,
          costLedgerPath: "/repo/.llm4ts/costs.jsonl",
          environment: noEnvironment
        }
      }
    })

  // Antigravity, Copilot, and Cursor stream exactly like this: content, no usage.
  const silent: ConnectorShape = {
    ...mock(),
    executeStream: (_prompt: string) =>
      Stream.make(LlmChunk.make({ delta: "done", finishReason: "stop" }))
  }

  const reporting: ConnectorShape = {
    ...mock(),
    executeStream: (_prompt: string) =>
      Stream.make(
        LlmChunk.make({
          delta: "done",
          finishReason: "stop",
          metadata: { model: "mock" },
          usage: TokenUsage.make({ prompt: 7, completion: 3, total: 10 })
        })
      )
  }

  it.effect("estimates a non-reporting seat and labels it, down to the ledger", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { dependencies, options } = yield* setupWith(silent)
        const bundle = yield* makeFlowRunnerContext(options, dependencies)
        yield* runWithBundle(
          bundle,
          options,
          (context) => completeAndPublish(context.coder, context.events, "x".repeat(40)),
          dependencies
        )
        const records = yield* loadCostLedger(dependencies.files, options.costLedgerPath)

        assert.strictEqual(records.length, 1)
        // 40 prompt characters and "done" at the default 4 chars per token.
        assert.strictEqual(records[0]?.totalPrompt, 10)
        assert.strictEqual(records[0]?.totalCompletion, 1)
        assert.deepStrictEqual(
          records[0]?.cells.map((cell) => cell.model),
          ["estimated:claude-sonnet-4"]
        )
      })
    )
  )

  it.effect("leaves a reporting seat measured", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { dependencies, options } = yield* setupWith(reporting)
        const bundle = yield* makeFlowRunnerContext(options, dependencies)
        yield* runWithBundle(
          bundle,
          options,
          (context) => completeAndPublish(context.coder, context.events, "x".repeat(40)),
          dependencies
        )
        const records = yield* loadCostLedger(dependencies.files, options.costLedgerPath)

        // The backend's own counts, not the 10 the character estimate would give.
        assert.deepStrictEqual(
          records[0]?.cells.map((cell) => cell.model),
          ["mock"]
        )
        assert.strictEqual(records[0]?.totalPrompt, 7)
        assert.strictEqual(records[0]?.totalCompletion, 3)
      })
    )
  )

  it.effect("accrues nothing when metering is switched off", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { state, dependencies, options: base } = yield* setupWith(silent)
        const options = { ...base, estimateUsage: false }
        const bundle = yield* makeFlowRunnerContext(options, dependencies)
        yield* runWithBundle(
          bundle,
          options,
          (context) => completeAndPublish(context.coder, context.events, "x".repeat(40)),
          dependencies
        )

        assert.strictEqual((yield* Ref.get(state))[options.costLedgerPath], undefined)
      })
    )
  )

  it.effect("reads the off switch from the environment", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { state, dependencies, options: base } = yield* setupWith(silent)
        const options = { ...base, environment: { LLM4TS_ESTIMATE_USAGE: "0" } }
        const bundle = yield* makeFlowRunnerContext(options, dependencies)
        yield* runWithBundle(
          bundle,
          options,
          (context) => completeAndPublish(context.coder, context.events, "x".repeat(40)),
          dependencies
        )

        assert.strictEqual((yield* Ref.get(state))[options.costLedgerPath], undefined)
      })
    )
  )

  // The decorator returns a bare `LlmServiceShape`: everything else the
  // connector carries has to survive the seat being metered.
  it.effect("keeps the connector's capabilities and batched label scoring", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const base = mock()
        const batching: ConnectorShape = {
          ...base,
          scoreLabelSequence: (_prompt, labelSets) =>
            Effect.succeed({
              entries: labelSets.map((labels) =>
                Result.succeed(
                  LabelDistribution.make({
                    probabilities: Object.fromEntries(
                      labels.map((label) => [label, 1 / labels.length])
                    ),
                    method: "verbalized",
                    support: 1
                  })
                )
              )
            })
        }
        const { dependencies, options } = yield* setupWith(batching)
        const bundle = yield* makeFlowRunnerContext(options, dependencies)

        assert.deepStrictEqual(bundle.context.coderCapabilities, base.capabilities)
        assert.isDefined(bundle.context.coder.scoreLabelSequence)
        // A seat without one must not appear to gain it.
        const plain = yield* setupWith(silent)
        const plainBundle = yield* makeFlowRunnerContext(plain.options, plain.dependencies)
        assert.isUndefined(plainBundle.context.coder.scoreLabelSequence)
      })
    )
  )
})
