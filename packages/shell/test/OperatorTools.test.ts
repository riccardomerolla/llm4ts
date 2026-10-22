import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { HealthStatus } from "@llm4ts/core/Models"
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
import { ExecutorSpec, RosterDocument } from "@llm4ts/flow/Roster"
import { StoryState, StoryStateVersion } from "@llm4ts/flow/Stories"
import { Story, StoryPlan, makeStoryPlanStore, storyHash } from "@llm4ts/flow/StoryPlan"
import type { DoctorReport } from "@llm4ts/runner/Doctor"
import type { OperatorConfig } from "@llm4ts/shell/OperatorConfig"
import { readHandlers, resolveRepo, type OperatorDeps } from "@llm4ts/shell/OperatorTools"
import type { RunSupervisorShape } from "@llm4ts/shell/RunSupervisor"

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
      config,
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
      flows: () => Effect.succeed([]),
      now: Effect.succeed(t0 + 60_000),
      environment: {}
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
