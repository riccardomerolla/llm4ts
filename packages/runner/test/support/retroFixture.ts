import * as Effect from "effect/Effect"
import { Board, BoardItem } from "@llm4ts/flow/BoardSync"
import {
  Info,
  ReviewFinding,
  ReviewFindings,
  StageFailed,
  StoryJudged,
  Timed
} from "@llm4ts/flow/FlowEvents"
import { TraceLine } from "@llm4ts/flow/FlowRecorder"
import { Plan, Task } from "@llm4ts/flow/Plan"
import {
  makeMemoryPlainFileStore,
  makePlanStore,
  saveVersioned,
  type PlainFileStoreShape
} from "@llm4ts/flow/Persistence"
import { loadEpicFiles, loadStoryFiles } from "@llm4ts/flow/Retro"
import {
  EpicReport,
  EpicReportVersion,
  StoryOutcome,
  StoryState,
  StoryStateVersion
} from "@llm4ts/flow/Stories"
import { Story, StoryPlan, makeStoryPlanStore, storyHash } from "@llm4ts/flow/StoryPlan"
import type { TranscriptEntry } from "@llm4ts/flow/Transcript"

export const story = (id: string, dependsOn: ReadonlyArray<string> = []): Story =>
  Story.make({
    id,
    title: `Story ${id}`,
    description: `Implement ${id}.`,
    dependsOn,
    owned: [`src/features/${id}`],
    sharedReadOnly: ["src/kit"],
    provides: [`route /${id}`]
  })

export const plan = StoryPlan.make({
  epicId: "conto",
  epic: "The current account.",
  stories: [story("a"), story("b", ["a"]), story("c")]
})

export const stateDir = "/repo/.llm4ts/epics/conto"

export const event = (seq: number, value: unknown): TraceLine =>
  TraceLine.make({
    schemaVersion: 1,
    seq,
    timestamp: 1_000 + seq,
    runId: "run-1",
    kind: "Event",
    fields: { event: JSON.stringify(value) }
  })

export const trace: ReadonlyArray<TraceLine> = [
  event(1, Info.make({ message: "gates: pnpm lint · pnpm test" })),
  event(2, Info.make({ message: "node: v24.12.0 satisfies >=22 (package.json engines.node)" })),
  event(
    3,
    Info.make({ message: "⟳ flaky stream (fresh retry) — retry 1/6: empty response", lane: "a" })
  ),
  event(
    4,
    Info.make({ message: "⟳ flaky stream (fresh retry) — retry 2/6: empty response", lane: "a" })
  ),
  event(
    5,
    ReviewFindings.make({
      round: 1,
      settled: false,
      lane: "a",
      issues: [ReviewFinding.make({ severity: "Warning", title: "missing test" })]
    })
  ),
  event(
    6,
    Timed.make({ kind: "gate", label: "pnpm test", ms: 1200, exitCode: 1, failed: true, lane: "a" })
  ),
  event(
    7,
    StoryJudged.make({
      lane: "a",
      round: 1,
      cleared: false,
      issues: 1,
      dimensions: [{ id: "tests", score: 0, max: 2 }]
    })
  ),
  event(
    8,
    StageFailed.make({ stage: "story a", message: "judge not cleared after 1 revision", lane: "a" })
  ),
  TraceLine.make({
    schemaVersion: 1,
    seq: 9,
    timestamp: 1_009,
    runId: "run-1",
    kind: "RunEnded",
    fields: { outcome: "failed" }
  })
]

export const transcriptA: ReadonlyArray<TranscriptEntry> = [
  { _tag: "Call", at: 1, call: "call-1", role: "judge", input: "Judge the story diff below" },
  { _tag: "Tool", at: 2, call: "call-1", tool: "glob", args: "**/*.ts" },
  { _tag: "Tool", at: 3, call: "call-1", tool: "read_file", args: "src/x.ts" },
  { _tag: "Tool", at: 4, call: "call-1", tool: "read_file", args: "src/y.ts" },
  { _tag: "ToolResult", at: 5, call: "call-1", output: "denied by policy", failed: true },
  { _tag: "Reply", at: 6, call: "call-1", text: "I will now explore the codebase" },
  { _tag: "End", at: 7, call: "call-1", ms: 42_000, failed: true }
]

export const seeded = Effect.gen(function* () {
  const memory = yield* makeMemoryPlainFileStore()
  const files = memory.store
  yield* makeStoryPlanStore(files).save(`${stateDir}/plan.md`, plan)
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
        StoryOutcome.make({
          id: "a",
          title: "Story a",
          status: "failed",
          reason: "judge not cleared after 1 revision"
        }),
        StoryOutcome.make({
          id: "b",
          title: "Story b",
          status: "waiting",
          reason: "waiting for a"
        }),
        StoryOutcome.make({
          id: "c",
          title: "Story c",
          status: "done",
          judge: "judge cleared (round 1)"
        })
      ]
    })
  )
  yield* saveVersioned(
    files,
    `${stateDir}/board.json`,
    1,
    Board,
    Board.make({
      title: "Epic: conto",
      items: [
        BoardItem.make({
          id: "a",
          title: "Story a",
          status: "failed",
          detail: "judge not cleared after 1 revision"
        }),
        BoardItem.make({ id: "b", title: "Story b", status: "waiting", detail: "waiting for a" }),
        BoardItem.make({ id: "c", title: "Story c", status: "done" })
      ]
    })
  )
  for (const [id, status] of [
    ["a", "failed"],
    ["c", "merged"]
  ] as const) {
    yield* saveVersioned(
      files,
      `${stateDir}/stories/${id}.json`,
      StoryStateVersion,
      StoryState,
      StoryState.make({
        id,
        hash: storyHash(story(id)),
        branch: `story/conto/${id}`,
        worktree: `/repo.worktrees/conto/${id}`,
        status
      })
    )
  }
  yield* makePlanStore(files).save(
    `${stateDir}/stories/a.plan.md`,
    Plan.make({
      epicId: "conto",
      tasks: [
        Task.make({ title: "add the route", description: "…", completed: true }),
        Task.make({ title: "Revision 1: close the judge's findings", description: "…" })
      ]
    })
  )
  yield* files.append(
    `${stateDir}/stories/a.findings.md`,
    "## judge round 1 — not cleared (tests 0/2)\n- [Critical] no test for the route: add one\n\n"
  )
  return files
})

export const loadInputs = (files: PlainFileStoreShape) =>
  Effect.gen(function* () {
    const epic = yield* loadEpicFiles(files, stateDir)
    const stories = yield* Effect.forEach(plan.stories, (item) =>
      loadStoryFiles(files, stateDir, item)
    )
    return {
      runId: "run-1",
      plan,
      trace,
      transcripts: new Map([["a", transcriptA]]),
      report: epic.report,
      board: epic.board,
      stories
    }
  })
