import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import { TestClock } from "effect/testing"
import { HealthStatus } from "@llm4ts/core/Models"
import { withDraftApproval } from "@llm4ts/flow/Approval"
import { Board, BoardItem } from "@llm4ts/flow/BoardSync"
import { EpicRun, appendEpicRun } from "@llm4ts/flow/EpicRuns"
import {
  Info,
  StageFailed,
  StageStarted,
  StoryStatusChanged,
  type FlowEvent
} from "@llm4ts/flow/FlowEvents"
import { TraceLine } from "@llm4ts/flow/FlowRecorder"
import { OperatorRun } from "@llm4ts/flow/OperatorSchemas"
import { makeMemoryPlainFileStore, saveVersioned } from "@llm4ts/flow/Persistence"
import { retroApprovalOf } from "@llm4ts/flow/Retro"
import { ExecutorSpec, RosterDocument } from "@llm4ts/flow/Roster"
import { StoryState, StoryStateVersion } from "@llm4ts/flow/Stories"
import { Story, StoryPlan, makeStoryPlanStore, storyHash } from "@llm4ts/flow/StoryPlan"
import type { DoctorReport } from "@llm4ts/runner/Doctor"
import type { DiscoveredFlow } from "@llm4ts/shell/FlowCatalog"
import { actHandlers, waitHandlers } from "@llm4ts/shell/OperatorActTools"
import type { OperatorConfig } from "@llm4ts/shell/OperatorConfig"
import { readHandlers, resolveRepo, type OperatorDeps } from "@llm4ts/shell/OperatorTools"
import type { RunSupervisorShape, StartRun } from "@llm4ts/shell/RunSupervisor"

const t0 = 1_790_000_000_000
const repoPath = "/repo"
const stateDir = "/repo/.llm4ts/epics/conto"
const tracePath = "/repo/.llm4ts/trace-1790000000000.jsonl"
const healthUrl = "http://127.0.0.1:1234/v1/models"
/** What the MCP server hands a handler; these tools never stream preliminary results. */
const context = { preliminary: () => Effect.void }

const story = (id: string): Story =>
  Story.make({
    id,
    title: `Story ${id}`,
    description: `Implement ${id}.`,
    dependsOn: [],
    owned: [`src/features/${id}`],
    sharedReadOnly: [],
    provides: []
  })

const plan = StoryPlan.make({
  epicId: "conto",
  epic: "The current account.",
  stories: [story("a"), story("b")]
})

const line = (
  seq: number,
  kind: string,
  fields: TraceLine["fields"],
  runId = "op-1",
  start = t0
): TraceLine =>
  TraceLine.make({ schemaVersion: 1, seq, timestamp: start + seq * 1_000, runId, kind, fields })

const event = (seq: number, value: FlowEvent): TraceLine =>
  line(seq, value._tag, { event: JSON.stringify(value) })

const encode = (lines: ReadonlyArray<TraceLine>): string =>
  lines.map((entry) => JSON.stringify(entry)).join("\n") + "\n"

const trace: ReadonlyArray<TraceLine> = [
  event(1, StoryStatusChanged.make({ id: "a", status: "active" })),
  event(2, StageStarted.make({ stage: "story a", lane: "a" })),
  event(3, Info.make({ message: "gates: pnpm test" })),
  event(4, StageFailed.make({ stage: "story a", message: "tests red", lane: "a" })),
  event(5, StoryStatusChanged.make({ id: "a", status: "failed" }))
]

const run = new OperatorRun({
  runId: "op-1",
  repo: "app",
  flow: "epic-stories",
  args: ["--epic", "conto"],
  knobs: { epic: "conto" },
  startedAt: t0,
  pid: 4242,
  tracePath,
  logDir: "/state/llm4ts/mcp/app/runs/op-1",
  state: "running"
})

const config: OperatorConfig = {
  transport: { _tag: "stdio" },
  repos: [{ id: "app", path: repoPath }],
  allowRun: false,
  allowApprove: false,
  parallelRuns: 1
}

const supervisor: RunSupervisorShape = {
  start: () => Effect.die("unused"),
  stop: () => Effect.die("unused"),
  get: (runId) => Effect.succeed(runId === run.runId ? run : undefined),
  list: () => Effect.succeed([run])
}

const emptySupervisor: RunSupervisorShape = {
  ...supervisor,
  get: () => Effect.succeed(undefined),
  list: () => Effect.succeed([])
}

const doctorReport: DoctorReport = {
  connectors: [
    {
      id: "claude",
      status: HealthStatus.make({ availability: "Healthy", authStatus: "Valid" }),
      probe: "version"
    },
    {
      id: "openai",
      status: HealthStatus.make({ availability: "Unknown", authStatus: "Missing" }),
      probe: "unknown"
    }
  ],
  node: { _tag: "Off", summary: "node preflight off" },
  lines: ["credentials: OPENAI_API_KEY missing"]
}

interface SeedOptions {
  readonly supervisor?: RunSupervisorShape
  /** Leave the supervised run's trace unwritten, as right after `start_run`. */
  readonly withoutTrace?: boolean
  /** The epic's `runs.jsonl` verbatim, instead of one record naming `op-1`. */
  readonly epicRuns?: string
  readonly traces?: ReadonlyArray<string>
  readonly flows?: ReadonlyArray<DiscoveredFlow>
  readonly environment?: Readonly<Record<string, string | undefined>>
  readonly config?: OperatorConfig
}

const seeded = (extra: Readonly<Record<string, string>> = {}, options: SeedOptions = {}) =>
  Effect.gen(function* () {
    const memory = yield* makeMemoryPlainFileStore({
      ...(options.withoutTrace === true ? {} : { [tracePath]: encode(trace) }),
      ...extra
    })
    const files = memory.store
    yield* makeStoryPlanStore(files).save(`${stateDir}/plan.md`, plan)
    yield* saveVersioned(
      files,
      `${stateDir}/board.json`,
      1,
      Board,
      Board.make({
        title: "Epic: conto",
        items: [
          BoardItem.make({ id: "a", title: "Story a", status: "failed", detail: "tests red" }),
          BoardItem.make({ id: "b", title: "Story b", status: "planned" })
        ]
      })
    )
    yield* saveVersioned(
      files,
      `${stateDir}/stories/a.json`,
      StoryStateVersion,
      StoryState,
      StoryState.make({
        id: "a",
        hash: storyHash(story("a")),
        branch: "story/conto/a",
        worktree: "/repo.worktrees/conto/a",
        status: "failed"
      })
    )
    if (options.epicRuns === undefined) {
      yield* appendEpicRun(
        files,
        stateDir,
        EpicRun.make({ runId: "op-1", tracePath, action: "RunPlan", startedAt: t0 })
      )
    } else {
      yield* files.writeAtomic(`${stateDir}/runs.jsonl`, options.epicRuns)
    }
    const probed: Array<string> = []
    const deps: OperatorDeps = {
      config: options.config ?? config,
      files,
      listFiles: () => [],
      listTraces: (directory) =>
        directory === "/repo/.llm4ts" ? (options.traces ?? [tracePath]) : [],
      listEpics: (directory) => (directory === "/repo/.llm4ts/epics" ? ["conto"] : []),
      transcripts: { read: () => Effect.succeed(undefined), list: () => [] },
      supervisor: options.supervisor ?? supervisor,
      doctor: Effect.succeed(doctorReport),
      roster: () =>
        Effect.succeed({
          document: RosterDocument.make({
            executors: [
              ExecutorSpec.make({
                id: "lm",
                harness: "lm-studio",
                roles: ["coder"],
                health: healthUrl
              })
            ]
          }),
          exclusions: [],
          statePath: "/state/llm4ts/roster-state.json"
        }),
      probe: (url) =>
        Effect.sync(() => {
          probed.push(url)
          return url === healthUrl
        }),
      flows: () => Effect.succeed(options.flows ?? []),
      now: Effect.succeed(t0 + 60_000),
      environment: options.environment ?? {}
    }
    return { deps, probed, memory }
  })

describe("OperatorTools", () => {
  it.effect("preflight never reports a bare Valid: a CLI connector carries probe version", () =>
    Effect.gen(function* () {
      const { deps } = yield* seeded()
      const result = yield* readHandlers(deps).preflight({}, context)
      const claude = result.connectors.find((connector) => connector.id === "claude")
      assert.strictEqual(claude?.authStatus, "Valid")
      assert.strictEqual(claude?.probe, "version")
      for (const connector of result.connectors) {
        assert.include(["version", "unknown"], connector.probe)
      }
      assert.strictEqual(result.node, process.version)
      assert.deepStrictEqual(result.notes, ["credentials: OPENAI_API_KEY missing"])
    })
  )

  it.effect("preflight probes executor health", () =>
    Effect.gen(function* () {
      const { deps, probed } = yield* seeded()
      const result = yield* readHandlers(deps).preflight({}, context)
      assert.deepStrictEqual(probed, [healthUrl])
      assert.deepStrictEqual(result.executors, [
        { id: "lm", harness: "lm-studio", roles: ["coder"], disabled: false, healthy: true }
      ])
    })
  )

  it.effect("run_status folds the supervised run's trace", () =>
    Effect.gen(function* () {
      const { deps } = yield* seeded()
      const status = yield* readHandlers(deps).run_status({ runId: "op-1" }, context)
      assert.strictEqual(status.state, "running")
      assert.strictEqual(status.seq, 5)
      assert.isTrue(status.summary.length > 0)
      assert.deepStrictEqual(
        status.stories.map((entry) => `${entry.id}:${entry.status}`),
        ["a:failed", "b:planned"]
      )
    })
  )

  it.effect("diagnose with a story returns the retro digest", () =>
    Effect.gen(function* () {
      const { deps } = yield* seeded()
      const diagnosis = yield* readHandlers(deps).diagnose({ runId: "op-1", story: "a" }, context)
      assert.strictEqual(diagnosis.story, "a")
      assert.include(diagnosis.digest, "a")
      assert.strictEqual(diagnosis.failure?.message, "tests red")
      const refused = yield* Effect.exit(
        readHandlers(deps).diagnose({ runId: "op-1", story: "../x" }, context)
      )
      assert.isTrue(Exit.isFailure(refused))
    })
  )

  it.effect("diagnose without a story returns the run-level digest", () =>
    Effect.gen(function* () {
      const { deps } = yield* seeded()
      const diagnosis = yield* readHandlers(deps).diagnose({ runId: "op-1" }, context)
      assert.isUndefined(diagnosis.story)
      assert.include(diagnosis.digest, "gates: pnpm test")
      assert.deepStrictEqual(diagnosis.failure, {
        stage: "story a",
        message: "tests red",
        lane: "a"
      })
    })
  )

  it.effect("resolveRepo accepts no id with one repo and refuses an unknown one", () =>
    Effect.gen(function* () {
      const only = yield* resolveRepo(config, undefined)
      assert.deepStrictEqual(only, { id: "app", path: repoPath })
      const unknown = yield* Effect.flip(resolveRepo(config, "nope"))
      assert.strictEqual(unknown._tag, "UnknownRepo")
      const two: OperatorConfig = {
        ...config,
        repos: [...config.repos, { id: "other", path: "/other" }]
      }
      const ambiguous = yield* Effect.flip(resolveRepo(two, undefined))
      assert.strictEqual(ambiguous._tag, "UnknownRepo")
      assert.deepStrictEqual(yield* resolveRepo(two, "other"), { id: "other", path: "/other" })
    })
  )

  it.effect("run_events bounds limit at 1000", () =>
    Effect.gen(function* () {
      const long = Array.from({ length: 1_200 }, (_, index) =>
        event(index + 1, Info.make({ message: `line ${index + 1}` }))
      )
      const { deps } = yield* seeded({ [tracePath]: encode(long) })
      const handlers = readHandlers(deps)
      const bounded = yield* handlers.run_events({ runId: "op-1", limit: 5_000 }, context)
      assert.strictEqual(bounded.length, 1_000)
      const byDefault = yield* handlers.run_events({ runId: "op-1" }, context)
      assert.strictEqual(byDefault.length, 200)
      const since = yield* handlers.run_events({ runId: "op-1", sinceSeq: 1_195 }, context)
      assert.deepStrictEqual(
        since.map((entry) => entry.seq),
        [1_196, 1_197, 1_198, 1_199, 1_200]
      )
    })
  )

  it.effect("runs found on disk: list_runs states, order and limit; run_status; UnknownRun", () =>
    Effect.gen(function* () {
      const oldTrace = "/repo/.llm4ts/trace-1790000100000.jsonl"
      const newTrace = "/repo/.llm4ts/trace-1790000200000.jsonl"
      const ended = [
        line(
          1,
          "Event",
          { event: JSON.stringify(Info.make({ message: "hi" })) },
          "run-old",
          t0 + 100_000
        ),
        line(2, "RunEnded", { outcome: "completed" }, "run-old", t0 + 100_000)
      ]
      const open = [
        line(
          1,
          "StoryStatusChanged",
          {
            event: JSON.stringify(StoryStatusChanged.make({ id: "a", status: "active" }))
          },
          "run-new",
          t0 + 200_000
        )
      ]
      const { deps } = yield* seeded(
        { [oldTrace]: encode(ended), [newTrace]: encode(open) },
        {
          supervisor: emptySupervisor,
          traces: [oldTrace, newTrace],
          epicRuns: `${JSON.stringify({
            runId: "run-old",
            tracePath: oldTrace,
            action: "RunPlan",
            startedAt: t0 + 100_000
          })}\n`
        }
      )
      const handlers = readHandlers(deps)
      const runs = yield* handlers.list_runs({}, context)
      assert.deepStrictEqual(
        runs.map((run) => `${run.runId}:${run.state}:${run.flow}`),
        ["run-new:running:?", "run-old:exited:?"]
      )
      const limited = yield* handlers.list_runs({ limit: 1 }, context)
      assert.deepStrictEqual(
        limited.map((run) => run.runId),
        ["run-new"]
      )
      const ofEpic = yield* handlers.list_runs({ epic: "conto" }, context)
      assert.deepStrictEqual(
        ofEpic.map((run) => run.runId),
        ["run-old"]
      )
      const status = yield* handlers.run_status({ runId: "run-new" }, context)
      assert.strictEqual(status.state, "running")
      assert.strictEqual(status.seq, 1)
      const old = yield* handlers.run_status({ runId: "run-old" }, context)
      assert.strictEqual(old.state, "exited")
      const unknown = yield* Effect.flip(handlers.run_status({ runId: "nope" }, context))
      assert.strictEqual(unknown._tag, "UnknownRun")
    })
  )

  it.effect("a supervised run whose trace is not written yet reads as an empty trace", () =>
    Effect.gen(function* () {
      const { deps } = yield* seeded({}, { withoutTrace: true })
      const handlers = readHandlers(deps)
      const status = yield* handlers.run_status({ runId: "op-1" }, context)
      assert.strictEqual(status.state, "running")
      assert.strictEqual(status.seq, 0)
      assert.deepStrictEqual(status.lanes, [])
      assert.deepStrictEqual(yield* handlers.run_events({ runId: "op-1" }, context), [])
      const profiled = yield* handlers.profile({ runId: "op-1" }, context)
      assert.isDefined(profiled)
      const cost = yield* handlers.costs({ runId: "op-1" }, context)
      assert.isTrue("total" in cost && cost.total === 0)

      const corrupt = yield* seeded({ [tracePath]: "not json\n" })
      const failed = yield* Effect.flip(
        readHandlers(corrupt.deps).run_status({ runId: "op-1" }, context)
      )
      assert.strictEqual(failed._tag, "TraceUnreadable")
    })
  )

  it.effect("a corrupt runs.jsonl fails ReadFailed naming it, a missing one reads as no runs", () =>
    Effect.gen(function* () {
      const valid = JSON.stringify({ runId: "op-1", tracePath, action: "RunPlan", startedAt: t0 })
      const { deps } = yield* seeded(
        {},
        { supervisor: emptySupervisor, epicRuns: `garbage\n${valid}\n` }
      )
      const handlers = readHandlers(deps)
      const listed = yield* Effect.flip(handlers.list_runs({}, context))
      assert.strictEqual(listed._tag, "ReadFailed")
      assert.include(listed.message, `${stateDir}/runs.jsonl`)
      const looked = yield* Effect.flip(handlers.run_status({ runId: "op-1" }, context))
      assert.strictEqual(looked._tag, "ReadFailed")
      const epics = yield* Effect.flip(handlers.list_epics({}, context))
      assert.strictEqual(epics._tag, "ReadFailed")

      const missing = yield* seeded({}, { supervisor: emptySupervisor, epicRuns: "" })
      const found = yield* readHandlers(missing.deps).list_runs({}, context)
      assert.deepStrictEqual(
        found.map((run) => `${run.runId}:${run.state}`),
        ["op-1:running"]
      )
    })
  )
})

/** A supervisor whose one run a test can flip to another state, recording every start. */
const controllable = () => {
  let current = run
  const started: Array<StartRun> = []
  const shape: RunSupervisorShape = {
    start: (request) =>
      Effect.sync(() => {
        started.push(request)
        return new OperatorRun({
          runId: "op-2",
          repo: request.repo.id,
          flow: request.flow.name,
          args: [],
          knobs: request.knobs,
          startedAt: t0,
          pid: 777,
          tracePath: "/repo/.llm4ts/trace-2.jsonl",
          logDir: "/state/llm4ts/mcp/app/runs/op-2",
          state: "running"
        })
      }),
    stop: () => Effect.sync(() => current),
    get: (runId) => Effect.sync(() => (runId === current.runId ? current : undefined)),
    list: () => Effect.sync(() => [current])
  }
  const exit = () => {
    current = new OperatorRun({ ...current, state: "exited", endedAt: t0 + 90_000 })
  }
  return { shape, started, exit }
}

/** A server started with --allow-run and --allow-approve. */
const allowed: OperatorConfig = { ...config, allowRun: true, allowApprove: true }

const flowsFound: ReadonlyArray<DiscoveredFlow> = [
  { name: "epic-stories", path: "/flows/epic-stories.js", tier: "builtin", shadows: [] },
  { name: "epic-retro", path: "/flows/epic-retro.js", tier: "builtin", shadows: [] }
]

describe("OperatorActTools", () => {
  it.effect("run_wait returns on the first meaningful event", () =>
    Effect.gen(function* () {
      const { deps, memory } = yield* seeded({}, { withoutTrace: true })
      const fiber = yield* Effect.forkChild(
        waitHandlers(deps).run_wait({ runId: "op-1", sinceSeq: 0 }, context)
      )
      yield* TestClock.adjust("500 millis")
      assert.isUndefined(fiber.pollUnsafe())
      yield* memory.store.append(
        tracePath,
        encode([event(1, StoryStatusChanged.make({ id: "a", status: "active" }))])
      )
      yield* TestClock.adjust("500 millis")
      const result = yield* Fiber.join(fiber)
      assert.strictEqual(result.events.length, 1)
      assert.strictEqual(result.events[0]?.kind, "StoryStatusChanged")
      assert.strictEqual(result.seq, 1)
      assert.isFalse(result.exited)
      assert.isTrue(result.summary.length > 0)
    })
  )

  it.effect("run_wait returns exited when the supervisor's run is no longer running", () =>
    Effect.gen(function* () {
      const fake = controllable()
      const { deps } = yield* seeded({}, { supervisor: fake.shape })
      const fiber = yield* Effect.forkChild(
        waitHandlers(deps).run_wait({ runId: "op-1", sinceSeq: 5 }, context)
      )
      yield* TestClock.adjust("500 millis")
      assert.isUndefined(fiber.pollUnsafe())
      fake.exit()
      yield* TestClock.adjust("500 millis")
      const result = yield* Fiber.join(fiber)
      assert.isTrue(result.exited)
      assert.deepStrictEqual(result.events, [])
      assert.strictEqual(result.seq, 5)
    })
  )

  it.effect("run_wait times out empty", () =>
    Effect.gen(function* () {
      const { deps } = yield* seeded()
      const fiber = yield* Effect.forkChild(
        waitHandlers(deps).run_wait({ runId: "op-1", sinceSeq: 5, timeoutSeconds: 5 }, context)
      )
      yield* TestClock.adjust("4500 millis")
      assert.isUndefined(fiber.pollUnsafe())
      yield* TestClock.adjust("500 millis")
      const result = yield* Fiber.join(fiber)
      assert.deepStrictEqual(result.events, [])
      assert.strictEqual(result.seq, 5)
      assert.isFalse(result.exited)
    })
  )

  it.effect("start_run resolves the flow and passes typed knobs to the supervisor", () =>
    Effect.gen(function* () {
      const fake = controllable()
      const environment = { PATH: "/usr/bin" }
      const { deps } = yield* seeded(
        {},
        { supervisor: fake.shape, flows: flowsFound, environment, config: allowed }
      )
      const handlers = actHandlers(deps)
      const started = yield* handlers.start_run(
        { flow: "epic-stories", epic: "conto", judgeRounds: 2, executors: ["lm"], land: "main" },
        context
      )
      assert.deepStrictEqual(started, {
        runId: "op-2",
        tracePath: "/repo/.llm4ts/trace-2.jsonl",
        pid: 777
      })
      assert.deepStrictEqual(fake.started, [
        {
          repo: { id: "app", path: repoPath },
          flow: { name: "epic-stories", path: "/flows/epic-stories.js" },
          knobs: { epic: "conto", judgeRounds: 2, executors: ["lm"], land: "main" },
          baseEnvironment: environment
        }
      ])
      const unknown = yield* Effect.flip(handlers.start_run({ flow: "nope" }, context))
      assert.strictEqual(unknown._tag, "UnknownFlow")
      assert.strictEqual(fake.started.length, 1)
    })
  )

  it.effect("approve ticks the retro report's marker and refuses an unknown retro", () =>
    Effect.gen(function* () {
      const report = `${stateDir}/retro/op-1.md`
      const { deps, memory } = yield* seeded(
        { [report]: withDraftApproval("# Retro of op-1") },
        { config: allowed }
      )
      const handlers = actHandlers(deps)
      const approved = yield* handlers.approve(
        { kind: "retro", epic: "conto", id: "op-1" },
        context
      )
      assert.deepStrictEqual(approved, { path: report, approved: true })
      const written = yield* memory.store.read(report)
      assert.isTrue(retroApprovalOf(written ?? "").approved)
      const unknown = yield* Effect.flip(
        handlers.approve({ kind: "retro", epic: "conto", id: "op-9" }, context)
      )
      assert.strictEqual(unknown._tag, "UnknownRun")
      const noEpic = yield* Effect.flip(
        handlers.approve({ kind: "retro", epic: "../x", id: "op-1" }, context)
      )
      assert.strictEqual(noEpic._tag, "UnknownEpic")
    })
  )

  it.effect("retro_start starts epic-retro with --epic and --run", () =>
    Effect.gen(function* () {
      const fake = controllable()
      const { deps } = yield* seeded(
        {},
        { supervisor: fake.shape, flows: flowsFound, config: allowed }
      )
      const handlers = actHandlers(deps)
      const injected = yield* Effect.flip(
        handlers.retro_start({ epic: "conto", run: "--land=main" }, context)
      )
      assert.strictEqual(injected._tag, "UnknownRun")
      assert.strictEqual(fake.started.length, 0)
      const started = yield* handlers.retro_start({ epic: "conto", run: "op-1" }, context)
      assert.strictEqual(started.runId, "op-2")
      assert.deepStrictEqual(
        fake.started.map((request) => [request.flow, request.knobs]),
        [
          [
            { name: "epic-retro", path: "/flows/epic-retro.js" },
            { flags: ["--epic", "conto", "--run", "op-1"] }
          ]
        ]
      )
      const noEpic = yield* Effect.flip(handlers.retro_start({ epic: "nope" }, context))
      assert.strictEqual(noEpic._tag, "UnknownEpic")
      assert.strictEqual(fake.started.length, 1)
    })
  )

  it.effect("stop_run returns the supervisor's record", () =>
    Effect.gen(function* () {
      const fake = controllable()
      const { deps } = yield* seeded({}, { supervisor: fake.shape, config: allowed })
      const stopped = yield* actHandlers(deps).stop_run({ runId: "op-1" }, context)
      assert.strictEqual(stopped.runId, "op-1")
    })
  )

  it.effect("start_run passes a requestId through to the supervisor's knobs", () =>
    Effect.gen(function* () {
      const fake = controllable()
      const { deps } = yield* seeded(
        {},
        { supervisor: fake.shape, flows: flowsFound, config: allowed }
      )
      yield* actHandlers(deps).start_run({ flow: "epic-stories", requestId: "req-7" }, context)
      assert.deepStrictEqual(
        fake.started.map((request) => request.knobs),
        [{ requestId: "req-7" }]
      )
    })
  )

  it.effect("start_run refuses a pack path and a --repo flag before the supervisor", () =>
    Effect.gen(function* () {
      const fake = controllable()
      const { deps } = yield* seeded(
        {},
        { supervisor: fake.shape, flows: flowsFound, config: allowed }
      )
      const handlers = actHandlers(deps)
      const pack = yield* Effect.flip(
        handlers.start_run({ flow: "epic-stories", pack: "../x" }, context)
      )
      assert.strictEqual(pack._tag, "InvalidKnob")
      assert.isTrue(pack._tag === "InvalidKnob" && pack.knob === "pack")
      const repo = yield* Effect.flip(
        handlers.start_run({ flow: "epic-stories", flags: ["--repo", "/etc"] }, context)
      )
      assert.strictEqual(repo._tag, "InvalidKnob")
      const repoEq = yield* Effect.flip(
        handlers.start_run({ flow: "epic-stories", flags: ["--repo=/etc"] }, context)
      )
      assert.strictEqual(repoEq._tag, "InvalidKnob")
      assert.deepStrictEqual(fake.started, [])
    })
  )

  it.effect("run tools fail NotAllowed without --allow-run", () =>
    Effect.gen(function* () {
      const fake = controllable()
      const { deps } = yield* seeded(
        {},
        {
          supervisor: fake.shape,
          flows: flowsFound,
          config: { ...config, allowRun: false, allowApprove: true }
        }
      )
      const handlers = actHandlers(deps)
      const start = yield* Effect.flip(handlers.start_run({ flow: "epic-stories" }, context))
      assert.strictEqual(start._tag, "NotAllowed")
      const stop = yield* Effect.flip(handlers.stop_run({ runId: "op-1" }, context))
      assert.strictEqual(stop._tag, "NotAllowed")
      const retro = yield* Effect.flip(handlers.retro_start({ epic: "conto" }, context))
      assert.strictEqual(retro._tag, "NotAllowed")
      assert.deepStrictEqual(fake.started, [])
    })
  )

  it.effect("approve fails NotAllowed without --allow-approve", () =>
    Effect.gen(function* () {
      const report = `${stateDir}/retro/op-1.md`
      const draft = withDraftApproval("# Retro of op-1")
      const { deps, memory } = yield* seeded(
        { [report]: draft },
        { config: { ...config, allowRun: true, allowApprove: false } }
      )
      const refused = yield* Effect.flip(
        actHandlers(deps).approve({ kind: "retro", epic: "conto", id: "op-1" }, context)
      )
      assert.strictEqual(refused._tag, "NotAllowed")
      assert.strictEqual(yield* memory.store.read(report), draft)
    })
  )
})
