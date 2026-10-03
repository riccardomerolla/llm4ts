import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { Board, BoardItem } from "@llm4ts/flow/BoardSync"
import {
  Info,
  ReviewFinding,
  ReviewFindings,
  StageFailed,
  StoryJudged,
  Timed,
  makeCollectingFlowEvents
} from "@llm4ts/flow/FlowEvents"
import { TraceLine } from "@llm4ts/flow/FlowRecorder"
import { Plan, Task } from "@llm4ts/flow/Plan"
import {
  makeMemoryPlainFileStore,
  makePlanStore,
  saveVersioned,
  type PlainFileStoreShape
} from "@llm4ts/flow/Persistence"
import {
  RetroProposal,
  applyApprovedRetros,
  loadEpicFiles,
  loadStoryFiles,
  readRetroIndex,
  renderRetroDigest,
  renderRetroReport,
  retroApprovalOf,
  retroCandidates,
  retroPaths,
  retroPrompt,
  validateRetroProposal,
  writeRetro
} from "@llm4ts/flow/Retro"
import {
  EpicReport,
  EpicReportVersion,
  StoryOutcome,
  StoryState,
  StoryStateVersion
} from "@llm4ts/flow/Stories"
import { Story, StoryPlan, makeStoryPlanStore, storyHash } from "@llm4ts/flow/StoryPlan"
import type { TranscriptEntry } from "@llm4ts/flow/Transcript"

const story = (id: string, dependsOn: ReadonlyArray<string> = []): Story =>
  Story.make({
    id,
    title: `Story ${id}`,
    description: `Implement ${id}.`,
    dependsOn,
    owned: [`src/features/${id}`],
    sharedReadOnly: ["src/kit"],
    provides: [`route /${id}`]
  })

const plan = StoryPlan.make({
  epicId: "conto",
  epic: "The current account.",
  stories: [story("a"), story("b", ["a"]), story("c")]
})

const stateDir = "/repo/.llm4ts/epics/conto"

const event = (seq: number, value: unknown): TraceLine =>
  TraceLine.make({
    schemaVersion: 1,
    seq,
    timestamp: 1_000 + seq,
    runId: "run-1",
    kind: "Event",
    fields: { event: JSON.stringify(value) }
  })

const trace: ReadonlyArray<TraceLine> = [
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

const transcriptA: ReadonlyArray<TranscriptEntry> = [
  { _tag: "Call", at: 1, call: "call-1", role: "judge", input: "Judge the story diff below" },
  { _tag: "Tool", at: 2, call: "call-1", tool: "glob", args: "**/*.ts" },
  { _tag: "Tool", at: 3, call: "call-1", tool: "read_file", args: "src/x.ts" },
  { _tag: "Tool", at: 4, call: "call-1", tool: "read_file", args: "src/y.ts" },
  { _tag: "ToolResult", at: 5, call: "call-1", output: "denied by policy", failed: true },
  { _tag: "Reply", at: 6, call: "call-1", text: "I will now explore the codebase" },
  { _tag: "End", at: 7, call: "call-1", ms: 42_000, failed: true }
]

const seeded = Effect.gen(function* () {
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

const loadInputs = (files: PlainFileStoreShape) =>
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

describe("retro digest", () => {
  it.effect("looks at failed and waiting stories, never merged ones, and sums up each one", () =>
    Effect.gen(function* () {
      const files = yield* seeded
      const inputs = yield* loadInputs(files)
      assert.deepStrictEqual(
        retroCandidates(inputs).map((entry) => entry.story.id),
        ["a", "b"]
      )
      const digest = renderRetroDigest(inputs)
      assert.include(digest, "run outcome: failed")
      assert.include(digest, "- gates: pnpm lint · pnpm test")
      assert.include(digest, "## Story a — Story a")
      assert.include(digest, "outcome: failed — judge not cleared after 1 revision")
      assert.include(digest, "- [x] add the route")
      assert.include(digest, "- [ ] Revision 1: close the judge's findings")
      assert.include(digest, "no test for the route")
      assert.include(digest, "review round 1: 1 issue(s) — missing test")
      assert.include(digest, "gate failed: pnpm test (exit 1)")
      assert.include(digest, "judge round 1: not cleared, 1 issue(s) (tests 0/2)")
      assert.include(digest, "retries: flaky stream ×2")
      assert.include(digest, "tool calls: 3 (read_file ×2, glob ×1)")
      assert.include(digest, "failed tool results: 1")
      assert.include(digest, "last reply: I will now explore the codebase")
      assert.include(digest, "## Story b — Story b")
      assert.include(digest, "outcome: waiting — waiting for a")
      assert.include(digest, "none yet (the story never planned its tasks)")
      assert.notInclude(digest, "## Story c")
      assert.include(retroPrompt(digest, ["a"]), "have a task plan: a.")
    })
  )

  it.effect("says when the run kept no transcript and keeps the digest under its budget", () =>
    Effect.gen(function* () {
      const files = yield* seeded
      const inputs = { ...(yield* loadInputs(files)), transcripts: undefined, budget: 4_000 }
      const digest = renderRetroDigest(inputs)
      assert.include(digest, "transcripts: none (the run was started without --transcript)")
      assert.notInclude(digest, "### Transcript")
      assert.isAtMost(digest.length, 4_600)
    })
  )
})

describe("retro proposal validation", () => {
  const proposal = RetroProposal.make({
    summary: "Story a never got a test past the judge.",
    stories: [
      {
        id: "a",
        diagnosis: "The judge scored tests 0/2 and the gate failed.",
        kind: "tasks",
        tasks: [{ title: "write the route test", description: "Cover /a with a request test." }]
      },
      { id: "b", diagnosis: "Waits for a.", kind: "none", why: "unblocks once a merges" },
      { id: "c", diagnosis: "fine", kind: "none" },
      { id: "zzz", diagnosis: "not real", kind: "none" },
      {
        id: "b",
        diagnosis: "dup",
        kind: "story",
        changes: { owned: ["/etc/passwd"] }
      }
    ],
    runAdvice: [{ finding: "transcripts were off", evidence: "transcripts: none" }],
    libraryAdvice: []
  })

  it("drops what cannot be applied and says why", () => {
    const validated = validateRetroProposal(proposal, plan, new Set(["a"]))
    assert.deepStrictEqual(
      validated.proposal.stories.map((entry) => entry.id),
      ["a", "b", "c"]
    )
    assert.deepStrictEqual(validated.dropped, [
      "zzz: not a story of this plan",
      "b: named twice; the first entry stands"
    ])
    const noPlan = validateRetroProposal(
      RetroProposal.make({ ...proposal, stories: [{ ...proposal.stories[0]!, id: "b" }] }),
      plan,
      new Set(["a"])
    )
    assert.include(noPlan.dropped[0] ?? "", "never planned one")
    const outside = validateRetroProposal(
      RetroProposal.make({
        ...proposal,
        stories: [{ id: "a", diagnosis: "x", kind: "story", changes: { owned: ["../secrets"] } }]
      }),
      plan,
      new Set(["a"])
    )
    assert.include(outside.dropped[0] ?? "", "outside the repository")
    const noop = validateRetroProposal(
      RetroProposal.make({
        ...proposal,
        stories: [
          { id: "a", diagnosis: "x", kind: "story", changes: { owned: ["src/features/a"] } }
        ]
      }),
      plan,
      new Set(["a"])
    )
    assert.include(noop.dropped[0] ?? "", "changes nothing")
  })

  it("renders a report that ends in the draft approval line and lists what approval applies", () => {
    const validated = validateRetroProposal(proposal, plan, new Set(["a"]))
    const report = renderRetroReport({
      runId: "run-1",
      plan,
      validated,
      workDir: "/repo",
      epicDir: "conto"
    })
    assert.include(report, "# Retro — run run-1, epic conto")
    assert.include(report, "**Diagnosis.** The judge scored tests 0/2")
    assert.include(report, "- write the route test: Cover /a")
    assert.include(report, "- transcripts were off — transcripts: none")
    assert.include(report, "- zzz: not a story of this plan")
    assert.include(report, "- a: append 1 task(s) to its plan")
    assert.isTrue(report.trimEnd().endsWith("- [ ] Approved"))
    assert.deepStrictEqual(retroApprovalOf(report), { approved: false, applied: false })
    const ticked = report.replace("- [ ] Approved", "- [x] Approved")
    assert.deepStrictEqual(retroApprovalOf(ticked), { approved: true, applied: false })
    assert.deepStrictEqual(retroApprovalOf(`${ticked}- [x] Applied 2026-10-03\n`), {
      approved: true,
      applied: true
    })
  })
})

describe("applying approved retros", () => {
  const proposal = RetroProposal.make({
    summary: "s",
    stories: [
      {
        id: "a",
        diagnosis: "d",
        kind: "tasks",
        tasks: [{ title: "write the route test", description: "Cover /a." }]
      },
      {
        id: "b",
        diagnosis: "d",
        kind: "story",
        changes: { owned: ["src/features/b", "src/contracts/b"] },
        why: "it also needs its contract"
      },
      { id: "c", diagnosis: "d", kind: "refine", feedback: "split c in two" }
    ],
    runAdvice: [],
    libraryAdvice: [{ title: "judge explored", evidence: "tool calls: 3", suggestion: "say so" }]
  })

  it.effect(
    "applies nothing until approved, then tasks and story edits once, and marks the report",
    () =>
      Effect.gen(function* () {
        const files = yield* seeded
        const events = yield* makeCollectingFlowEvents
        const validated = validateRetroProposal(proposal, plan, new Set(["a"]))
        const inputs = yield* loadInputs(files)
        const paths = yield* writeRetro(files, stateDir, {
          runId: "run-1",
          plan,
          validated,
          workDir: "/repo",
          epicDir: "conto",
          digest: renderRetroDigest(inputs),
          at: 5
        })
        assert.strictEqual(paths.report, retroPaths(stateDir, "run-1").report)
        assert.include((yield* files.read(paths.library)) ?? "", "## judge explored")
        assert.deepStrictEqual(yield* readRetroIndex(files, stateDir), [{ runId: "run-1", at: 5 }])

        // Unapproved: untouched.
        const untouched = yield* applyApprovedRetros(files, stateDir, plan, events, 10)
        assert.deepStrictEqual(untouched.notes, [])
        assert.strictEqual(untouched.plan, plan)

        const report = (yield* files.read(paths.report)) ?? ""
        yield* files.writeAtomic(paths.report, report.replace("- [ ] Approved", "- [x] Approved"))
        const applied = yield* applyApprovedRetros(files, stateDir, plan, events, 10)
        assert.include(applied.notes, "run-1: a gets 1 task(s) from the retro")
        assert.include(applied.notes, "run-1: story b edited, restarting from a fresh worktree")
        assert.include(applied.notes, "run-1: c needs a refine round (not applied): split c in two")
        const taskPlan = yield* makePlanStore(files).load(`${stateDir}/stories/a.plan.md`)
        assert.deepStrictEqual(
          taskPlan?.tasks.map((task) => `${task.completed ? "x" : " "} ${task.title}`),
          [
            "x add the route",
            "  Revision 1: close the judge's findings",
            "  Retro run-1: write the route test"
          ]
        )
        assert.deepStrictEqual(applied.plan.story("b")?.owned, [
          "src/features/b",
          "src/contracts/b"
        ])
        const saved = yield* makeStoryPlanStore(files).load(`${stateDir}/plan.md`)
        assert.deepStrictEqual(saved?.story("b")?.owned, ["src/features/b", "src/contracts/b"])
        assert.notStrictEqual(storyHash(saved!.story("b")!), storyHash(story("b")))
        assert.isTrue(retroApprovalOf((yield* files.read(paths.report)) ?? "").applied)
        const published = (yield* events.recorded).filter((e) => e._tag === "Info").length
        assert.strictEqual(published, 3)

        // A second run applies nothing more.
        const again = yield* applyApprovedRetros(files, stateDir, applied.plan, events, 11)
        assert.deepStrictEqual(again.notes, [])
      })
  )

  it.effect("skips story edits that would leave the plan invalid, and still appends tasks", () =>
    Effect.gen(function* () {
      const files = yield* seeded
      const events = yield* makeCollectingFlowEvents
      const bad = RetroProposal.make({
        ...proposal,
        stories: [
          proposal.stories[0]!,
          {
            id: "b",
            diagnosis: "d",
            kind: "story",
            changes: { owned: ["src/features/a"] },
            why: "overlap"
          }
        ]
      })
      const validated = validateRetroProposal(bad, plan, new Set(["a"]))
      const paths = yield* writeRetro(files, stateDir, {
        runId: "run-2",
        plan,
        validated,
        workDir: "/repo",
        epicDir: "conto",
        digest: "d",
        at: 6
      })
      const report = (yield* files.read(paths.report)) ?? ""
      yield* files.writeAtomic(paths.report, report.replace("- [ ] Approved", "- [x] Approved"))
      const applied = yield* applyApprovedRetros(files, stateDir, plan, events, 10)
      assert.isTrue(applied.notes.some((note) => note.includes("would leave the plan invalid")))
      assert.strictEqual(applied.plan, plan)
      const taskPlan = yield* makePlanStore(files).load(`${stateDir}/stories/a.plan.md`)
      assert.strictEqual(taskPlan?.tasks.length, 3)
    })
  )
})
