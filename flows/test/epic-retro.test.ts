import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { appendEpicRun, EpicRun } from "@llm4ts/flow/EpicRuns"
import { Info, StageFailed, makeCollectingFlowEvents } from "@llm4ts/flow/FlowEvents"
import { TraceLine } from "@llm4ts/flow/FlowRecorder"
import { Plan, Task } from "@llm4ts/flow/Plan"
import { makeMemoryPlainFileStore, makePlanStore, saveVersioned } from "@llm4ts/flow/Persistence"
import { retroApprovalOf } from "@llm4ts/flow/Retro"
import { EpicReport, EpicReportVersion, StoryOutcome } from "@llm4ts/flow/Stories"
import { Story, StoryPlan, makeStoryPlanStore } from "@llm4ts/flow/StoryPlan"
import { parseEpicRetroArgs, resolveRetroTarget, runRetro } from "../lib/epic-retro.ts"
import { retroHint } from "../lib/epic-stories.ts"
import { scripted } from "./support.ts"

const stateDir = "/repo/.llm4ts/epics/conto"
const plan = StoryPlan.make({
  epicId: "conto",
  epic: "The current account.",
  stories: [
    Story.make({
      id: "a",
      title: "Story a",
      description: "Implement a.",
      owned: ["src/features/a"],
      provides: ["route /a"]
    })
  ]
})

const traceText = [
  TraceLine.make({
    schemaVersion: 1,
    seq: 1,
    timestamp: 1,
    runId: "run-1",
    kind: "Event",
    fields: {
      event: JSON.stringify(
        StageFailed.make({
          stage: "story a",
          message: "judge not cleared after 1 revision",
          lane: "a"
        })
      )
    }
  }),
  TraceLine.make({
    schemaVersion: 1,
    seq: 2,
    timestamp: 2,
    runId: "run-1",
    kind: "RunEnded",
    fields: { outcome: "failed" }
  })
]
  .map((line) => JSON.stringify(line))
  .join("\n")

const seeded = (failed: boolean) =>
  Effect.gen(function* () {
    const memory = yield* makeMemoryPlainFileStore()
    const files = memory.store
    yield* makeStoryPlanStore(files).save(`${stateDir}/plan.md`, plan)
    yield* files.writeAtomic("/repo/.llm4ts/trace-1.jsonl", traceText)
    yield* appendEpicRun(
      files,
      stateDir,
      EpicRun.make({
        runId: "run-1",
        tracePath: "/repo/.llm4ts/trace-1.jsonl",
        action: "RunPlan",
        startedAt: 1
      })
    )
    yield* saveVersioned(
      files,
      `${stateDir}/report.json`,
      EpicReportVersion,
      EpicReport,
      EpicReport.make({
        epicId: "conto",
        epicBranch: "epic/conto",
        estimated: true,
        stories: [
          failed
            ? StoryOutcome.make({
                id: "a",
                title: "Story a",
                status: "failed",
                reason: "judge not cleared"
              })
            : StoryOutcome.make({
                id: "a",
                title: "Story a",
                status: "done",
                judge: "judge cleared (round 1)"
              })
        ]
      })
    )
    yield* makePlanStore(files).save(
      `${stateDir}/stories/a.plan.md`,
      Plan.make({
        epicId: "conto",
        tasks: [Task.make({ title: "add the route", description: "…", completed: true })]
      })
    )
    return files
  })

describe("epic-retro arguments and target", () => {
  it.effect("reads --epic and --run and leaves the rest to the runner", () =>
    Effect.gen(function* () {
      const parsed = yield* parseEpicRetroArgs(["--epic", "conto", "--run=run-1", "--repo", "."])
      assert.deepStrictEqual(parsed, { epic: "conto", run: "run-1", rest: ["--repo", "."] })
      const usage = yield* Effect.flip(parseEpicRetroArgs(["--run"]))
      assert.strictEqual(usage._tag, "ScriptUsage")
    })
  )

  it.effect("takes the epic's latest run by default and names the ones it knows otherwise", () =>
    Effect.gen(function* () {
      const files = yield* seeded(true)
      const latest = yield* resolveRetroTarget(files, stateDir, undefined)
      assert.strictEqual(latest.run.runId, "run-1")
      assert.strictEqual(latest.stateDir, stateDir)
      const missing = yield* Effect.flip(resolveRetroTarget(files, stateDir, "run-9"))
      assert.include(missing.message, "no run 'run-9'")
      assert.include(missing.message, "run-1")
    })
  )
})

describe("runRetro", () => {
  const reply = {
    summary: "Story a never got its test past the judge.",
    stories: [
      {
        id: "a",
        diagnosis: "The judge was not cleared after one revision.",
        kind: "tasks",
        tasks: [{ title: "write the route test", description: "Cover /a with a request test." }]
      }
    ],
    runAdvice: [{ finding: "transcripts were off", evidence: "transcripts: none" }],
    libraryAdvice: [
      {
        title: "say the diff is the subject",
        evidence: "judge explored",
        suggestion: "add the line"
      }
    ]
  }

  it.effect(
    "writes the digest, the report with its approval line, the proposal and the library note",
    () =>
      Effect.gen(function* () {
        const files = yield* seeded(true)
        const events = yield* makeCollectingFlowEvents
        const seat = yield* scripted([reply])
        const target = yield* resolveRetroTarget(files, stateDir, undefined)
        const outcome = yield* runRetro({
          files,
          events,
          seat: seat.service,
          workDir: "/repo",
          epicDir: "conto",
          target,
          transcript: () => Effect.succeed(undefined),
          environment: {},
          now: 7
        })
        assert.strictEqual(outcome._tag, "Written")
        if (outcome._tag !== "Written") {
          return
        }
        const prompts = yield* seat.prompts
        assert.include(prompts[0] ?? "", "do not")
        assert.include(prompts[0] ?? "", "## Story a — Story a")
        assert.include(
          prompts[0] ?? "",
          "stage failed (story a): judge not cleared after 1 revision"
        )
        assert.include(prompts[0] ?? "", "transcripts: none")
        const report = (yield* files.read(outcome.paths.report)) ?? ""
        assert.include(report, "**Diagnosis.** The judge was not cleared")
        assert.deepStrictEqual(retroApprovalOf(report), { approved: false, applied: false })
        assert.include(
          (yield* files.read(outcome.paths.digest)) ?? "",
          "# Retro digest — run run-1"
        )
        assert.include((yield* files.read(outcome.paths.proposal)) ?? "", '"kind":"tasks"')
        assert.include(
          (yield* files.read(outcome.paths.library)) ?? "",
          "## say the diff is the subject"
        )
        const infos = (yield* events.recorded).flatMap((e) =>
          e._tag === "Info" ? [e.message] : []
        )
        assert.isTrue(
          infos.some((line) => line.includes("no transcripts; rerun with --transcript"))
        )
        assert.isTrue(infos.some((line) => line.includes("tick '- [x] Approved'")))
      })
  )

  it.effect("does nothing on a clean run, and says so without asking the seat", () =>
    Effect.gen(function* () {
      const files = yield* seeded(false)
      const events = yield* makeCollectingFlowEvents
      const seat = yield* scripted([reply])
      const target = yield* resolveRetroTarget(files, stateDir, undefined)
      const outcome = yield* runRetro({
        files,
        events,
        seat: seat.service,
        workDir: "/repo",
        epicDir: "conto",
        target,
        transcript: () => Effect.succeed(undefined),
        environment: {},
        now: 7
      })
      assert.strictEqual(outcome._tag, "NothingToDo")
      assert.strictEqual(yield* seat.calls, 0)
      assert.isUndefined(yield* files.read(`${stateDir}/retro/run-1.md`))
    })
  )
})

describe("the end-of-run hint", () => {
  it("names the retro command only when something failed or waits", () => {
    const red = EpicReport.make({
      epicId: "conto",
      epicBranch: "epic/conto",
      estimated: true,
      stories: [
        StoryOutcome.make({ id: "a", title: "a", status: "failed", reason: "x" }),
        StoryOutcome.make({ id: "b", title: "b", status: "waiting", reason: "waiting for a" })
      ]
    })
    assert.strictEqual(
      retroHint(red, "/repo", "conto-abc"),
      "1 failed, 1 waiting: llm4ts run epic-retro --repo /repo -- --epic conto-abc reads this run's trace and transcripts and proposes fixes for the next run"
    )
    const green = EpicReport.make({
      ...red,
      stories: [StoryOutcome.make({ id: "a", title: "a", status: "done" })]
    })
    assert.isUndefined(retroHint(green, "/repo", "conto-abc"))
    assert.isTrue(Info.make({ message: "x" })._tag === "Info")
  })
})
