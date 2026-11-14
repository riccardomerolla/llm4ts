import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as PubSub from "effect/PubSub"
import * as Queue from "effect/Queue"
import * as Ref from "effect/Ref"
import * as Stream from "effect/Stream"
import { CliConnectorConfig, type ConnectorConfig } from "@llm4ts/core/ConnectorConfig"
import { makeConnectorRegistry } from "@llm4ts/core/ConnectorRegistry"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import { ConnectorIds, LlmChunk, LlmConfig, type ConnectorId } from "@llm4ts/core/Models"
import { makeFakeProcessExecutor, makeProcessExecutor } from "@llm4ts/core/ProcessExecutor"
import { makeMockProvider } from "@llm4ts/core/providers/MockProvider"
import { collect } from "@llm4ts/core/Streaming"
import type { FlowEvent } from "@llm4ts/flow/FlowEvents"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"
import { ExecutorSpec, RosterDocument } from "@llm4ts/flow/Roster"
import { makeMemoryTranscriptSink } from "@llm4ts/flow/Transcript"
import { makeFlowRunnerContext, type FlowRunnerOptions } from "@llm4ts/runner/FlowRunner"

interface Resolved {
  readonly connector: string
  readonly readOnly: boolean
  readonly deniedPaths: ReadonlyArray<string> | undefined
}

const claude = CliConnectorConfig.make({ connectorId: ConnectorIds.ClaudeCli })
const codex = CliConnectorConfig.make({ connectorId: ConnectorIds.Codex })

/** The same seats, as a roster of one executor: every role on the coder's agent. */
const oneExecutor = RosterDocument.make({
  executors: [
    ExecutorSpec.make({
      id: "claude",
      harness: "claude",
      roles: ["coder", "planner", "reviewer", "judge"],
      slots: 2
    })
  ]
})

type Path = "plain" | "roster"

/**
 * Builds a run's context on one path, calls every seat the context offers
 * once, and reports what each call left behind: the configurations the
 * registry resolved, the timed model calls and the transcript calls.
 */
const runSeats = (path: Path, extra: Partial<FlowRunnerOptions> = {}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const process = yield* makeFakeProcessExecutor()
      const memory = yield* makeMemoryPlainFileStore()
      const transcript = yield* makeMemoryTranscriptSink
      const resolved = yield* Ref.make<ReadonlyArray<Resolved>>([])
      const answer = () => Stream.make(LlmChunk.make({ delta: "ok", finishReason: "stop" }))
      const mock = {
        ...makeMockProvider(LlmConfig.make({ provider: "Mock", model: "mock" })),
        executeStream: answer,
        executeStreamWithHistory: answer
      }
      const factory = (id: ConnectorId) => ({
        connectorId: id,
        kind: "Cli" as const,
        create: (config: ConnectorConfig) =>
          Ref.update(resolved, (all) => [
            ...all,
            {
              connector: id.value,
              readOnly: config instanceof CliConnectorConfig && config.readOnly === true,
              deniedPaths: config instanceof CliConnectorConfig ? config.deniedPaths : undefined
            }
          ]).pipe(Effect.as(mock))
      })
      const bundle = yield* makeFlowRunnerContext(
        {
          workDir: "/repo",
          workspace: "/repo",
          userPrompt: "do it",
          coder: claude,
          reviewers: [claude],
          runId: "run-1",
          environment: { HOME: "/home/me", LLM4TS_TRANSCRIPT: "on" },
          roster: path === "plain" ? "none" : oneExecutor,
          ...extra
        },
        {
          registry: makeConnectorRegistry([
            factory(ConnectorIds.ClaudeCli),
            factory(ConnectorIds.Codex)
          ]),
          process: process.executor,
          files: memory.store,
          transcriptSink: () => transcript.sink
        }
      )
      const context = bundle.context
      const seats: ReadonlyArray<readonly [string, LlmServiceShape | undefined]> = [
        ["coder", context.coder],
        ["reasoning", context.reasoning],
        ["reviewer", context.reviewers[0]],
        ["judge", context.judge]
      ]
      const timed: Record<string, ReadonlyArray<string>> = {}
      const transcribed: Record<string, ReadonlyArray<string>> = {}
      const subscription = yield* bundle.events.subscribe
      for (const [name, seat] of seats) {
        yield* PubSub.takeUpTo(subscription, 1000)
        const before = (yield* transcript.entries).length
        if (seat !== undefined) {
          yield* collect(seat.executeStream(`call ${name}`))
        }
        const events: ReadonlyArray<FlowEvent> = yield* PubSub.takeUpTo(subscription, 1000)
        timed[name] = events.flatMap((event) =>
          event._tag === "Timed" && event.kind === "model" ? [event.label] : []
        )
        transcribed[name] = (yield* transcript.entries)
          .slice(before)
          .flatMap(({ entry }) => (entry._tag === "Call" ? [entry.role] : []))
      }
      return {
        resolved: yield* Ref.get(resolved),
        timed,
        transcribed,
        hasRoster: context.roster !== undefined
      }
    })
  )

describe("a plain run and a roster of one executor per seat", () => {
  it.effect("deny every CLI seat the run's own state", () =>
    Effect.gen(function* () {
      for (const path of ["plain", "roster"] as const) {
        const { resolved } = yield* runSeats(path)
        assert.isAbove(resolved.length, 0)
        for (const seat of resolved) {
          assert.deepStrictEqual(seat.deniedPaths, [".llm4ts/**"], `${path} ${seat.connector}`)
        }
      }
    })
  )

  it.effect("deny every CLI seat the paths the run names, the flow's judgment seat included", () =>
    Effect.gen(function* () {
      for (const path of ["plain", "roster"] as const) {
        const { resolved } = yield* runSeats(path, { deniedPaths: [], judgment: codex })
        assert.include(
          resolved.map((seat) => seat.connector),
          ConnectorIds.Codex.value
        )
        for (const seat of resolved) {
          assert.deepStrictEqual(seat.deniedPaths, [], `${path} ${seat.connector}`)
        }
      }
    })
  )

  it.effect("time and transcribe every seat call once", () =>
    Effect.gen(function* () {
      for (const path of ["plain", "roster"] as const) {
        for (const extra of [{}, { judgment: codex }]) {
          const { timed, transcribed } = yield* runSeats(path, extra)
          const where = `${path}${"judgment" in extra ? " with the flow's judgment seat" : ""}`
          for (const seat of ["coder", "reasoning", "reviewer", "judge"]) {
            assert.strictEqual(timed[seat]?.length, 1, `${where}: ${seat} timed`)
            assert.strictEqual(transcribed[seat]?.length, 1, `${where}: ${seat} transcribed`)
          }
        }
      }
    })
  )

  // Intended differences: a roster names its seats by roster role
  // (ADR 0019), serves every reasoning role read-only, and gives the flow
  // `context.roster`; a plain run keeps the flow's own seat choices.
  it.effect("differ only where the roster is meant to", () =>
    Effect.gen(function* () {
      const plain = yield* runSeats("plain")
      const roster = yield* runSeats("roster")
      assert.deepStrictEqual(plain.timed, {
        coder: ["coder"],
        reasoning: ["reasoning"],
        reviewer: ["reviewer"],
        judge: ["judgment"]
      })
      assert.deepStrictEqual(roster.timed, {
        coder: ["coder"],
        reasoning: ["planner"],
        reviewer: ["reviewer"],
        judge: ["judge"]
      })
      assert.deepStrictEqual(
        [plain.hasRoster, roster.hasRoster],
        [false, true],
        "only a roster run offers context.roster"
      )
      // Plain: coder, reasoning, the reviewer as the flow passed it, the judge.
      assert.deepStrictEqual(
        plain.resolved.map((seat) => seat.readOnly),
        [false, true, false, true]
      )
      // Roster: the coder, then one read-only seat every reasoning role shares.
      assert.deepStrictEqual(
        roster.resolved.map((seat) => seat.readOnly),
        [false, true]
      )
    })
  )
})

describe("the gemini bridge (ADR 0016) follows the seats that run", () => {
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
  const bridgeOn = { LLM4TS_GEMINI_BRIDGE: "1", LLM4TS_GEMINI_BRIDGE_PORT: "0", HOME: "/home/me" }

  const withPi = (
    options: Pick<FlowRunnerOptions, "coder" | "roster">,
    readPiModelsJson: () => string | undefined
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const models = yield* Ref.make<ReadonlyArray<string | undefined>>([])
        const spawned = yield* Ref.make(0)
        const stdin = yield* Queue.unbounded<string>()
        const memory = yield* makeMemoryPlainFileStore()
        const mock = makeMockProvider(LlmConfig.make({ provider: "Mock", model: "mock" }))
        const registry = makeConnectorRegistry(
          [ConnectorIds.Pi, ConnectorIds.ClaudeCli].map((id) => ({
            connectorId: id,
            kind: "Cli" as const,
            create: (config: ConnectorConfig) =>
              (id.value === ConnectorIds.Pi.value
                ? Ref.update(models, (all) => [...all, config.model])
                : Effect.void
              ).pipe(Effect.as(mock))
          }))
        )
        const result = yield* makeFlowRunnerContext(
          {
            workDir: "/repo",
            workspace: "/repo",
            userPrompt: "do it",
            environment: bridgeOn,
            ...options
          },
          {
            registry,
            process: makeProcessExecutor({
              run: () => Effect.die("not used"),
              runStreaming: () => Stream.empty,
              runBidirectional: () =>
                Ref.update(spawned, (count) => count + 1).pipe(
                  Effect.as([stdin, Stream.never] as const)
                )
            }),
            files: memory.store,
            readPiModelsJson
          }
        ).pipe(Effect.result)
        return {
          ok: result._tag === "Success",
          piModels: yield* Ref.get(models),
          spawned: yield* Ref.get(spawned)
        }
      })
    )

  it.effect("starts for a roster's pi executor when the flow's own seats name no pi", () =>
    Effect.gen(function* () {
      const run = yield* withPi(
        {
          coder: claude,
          roster: RosterDocument.make({
            executors: [
              ExecutorSpec.make({ id: "pi", harness: "pi", roles: ["coder"] }),
              ExecutorSpec.make({
                id: "claude",
                harness: "claude",
                roles: ["planner", "reviewer", "judge"]
              })
            ]
          })
        },
        () => piModelsJson
      )
      assert.isTrue(run.ok)
      assert.strictEqual(run.spawned, 1)
      assert.deepStrictEqual(run.piModels, ["gemini-bridge/gemini-2.5-pro"])
    })
  )

  it.effect("stays down for a roster with no pi executor, whatever the flow's seats name", () =>
    Effect.gen(function* () {
      const run = yield* withPi(
        { coder: CliConnectorConfig.make({ connectorId: ConnectorIds.Pi }), roster: oneExecutor },
        // No bridge model: had the bridge been wanted, the run would fail here.
        () => undefined
      )
      assert.isTrue(run.ok)
      assert.strictEqual(run.spawned, 0)
      assert.deepStrictEqual(run.piModels, [])
    })
  )
})
