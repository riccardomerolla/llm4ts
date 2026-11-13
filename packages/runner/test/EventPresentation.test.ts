import { assert, describe, it } from "@effect/vitest"
import { Board } from "@llm4ts/core/blackboard/Fact"
import { RunResult } from "@llm4ts/core/blackboard/Run"
import { origins, truth, truthAnswer } from "@llm4ts/core/judgment/Schemas"
import { TokenUsage } from "@llm4ts/core/Models"
import {
  Aborted,
  AssistantMessage,
  Began,
  BlackboardRun,
  BriefReported,
  CapabilityDeniedEvent,
  CapabilityUnenforceable,
  CapabilityUsedEvent,
  CriterionChecked,
  EvidenceChecked,
  ExecutorExcluded,
  ExecutorHandedOver,
  ExecutorLeased,
  ExecutorReleased,
  ExecutorResumed,
  type FlowEvent,
  type FlowEventByTag,
  type FlowEventTag,
  Info,
  JudgmentObserved,
  Parked,
  ReviewFindingDemoted,
  ReviewFindings,
  RoundtableTurn,
  StageCompleted,
  StageFailed,
  StageStarted,
  StoryJudged,
  StoryStatusChanged,
  TaskCompleted,
  TaskStarted,
  TasksPlanned,
  Timed,
  TokensUsed,
  ToolUse,
  UsageProgress,
  laneOf
} from "@llm4ts/flow/FlowEvents"
import { digestedTags, presentationOf, type Verbosity } from "@llm4ts/runner/EventPresentation"
import { laneOfEvent, rendersEvent } from "@llm4ts/runner/Terminal"

const usage = TokenUsage.make({ prompt: 10, completion: 5, total: 15 })
const lane = "home"

/**
 * One instance of every event, in a lane when its class has one, with what the
 * switches this table replaced said of it: whether it prints at Quiet, Normal,
 * Verbose and Debug (`rendersEvent`), and its kind for a profile gap (`describe`).
 */
const cases: {
  readonly [K in FlowEventTag]: readonly [FlowEventByTag[K], prints: string, kind: string]
} = {
  JudgmentObserved: [
    JudgmentObserved.make({
      consumer: "satisfied-probe",
      key: "satisfied",
      state: { task: "task" },
      question: truth("Satisfied?"),
      answer: truthAnswer(0.9, origins.fake()),
      judgmentIdentity: "fake:checkpoint-1",
      decision: "act",
      certainty: 0.8,
      support: 1,
      origin: origins.fake(),
      outcome: { _tag: "SatisfiedProbe", literalMatch: false },
      mode: "observe"
    }),
    "0000",
    "an event"
  ],
  BlackboardRun: [
    BlackboardRun.make({
      ruleset: "story-board",
      result: RunResult.make({ board: Board.empty, trace: [], failures: [] })
    }),
    "0000",
    "an event"
  ],
  StageStarted: [StageStarted.make({ stage: "branch", lane }), "1111", "a stage start"],
  StageCompleted: [StageCompleted.make({ stage: "branch", lane }), "1111", "a stage end"],
  StageFailed: [
    StageFailed.make({ stage: "branch", message: "red", lane }),
    "1111",
    "a stage failure"
  ],
  Aborted: [Aborted.make({ message: "stopped" }), "1111", "an event"],
  Info: [Info.make({ message: "hello", lane }), "0111", "a log note"],
  ToolUse: [ToolUse.make({ tool: "shell", args: "ls", lane }), "0111", "a coder tool call"],
  AssistantMessage: [AssistantMessage.make({ text: "done", lane }), "0111", "an assistant message"],
  TokensUsed: [TokensUsed.make({ agent: "coder", usage, lane }), "0011", "a token report"],
  UsageProgress: [UsageProgress.make({ call: "c1", lane }), "0000", "an event"],
  ReviewFindings: [
    ReviewFindings.make({ round: 1, settled: true, issues: [], lane }),
    "0111",
    "a review round"
  ],
  CapabilityUsed: [
    CapabilityUsedEvent.make({ capability: "git", operation: "status" }),
    "0011",
    "a capability check"
  ],
  CapabilityDenied: [
    CapabilityDeniedEvent.make({ capability: "git", operation: "push" }),
    "1111",
    "a capability check"
  ],
  CapabilityUnenforceable: [
    CapabilityUnenforceable.make({ detail: "by rule" }),
    "1111",
    "a capability check"
  ],
  EvidenceChecked: [
    EvidenceChecked.make({ task: "Add multiply", claimed: 2, unverified: 1, lane }),
    "1111",
    "an evidence check"
  ],
  ReviewFindingDemoted: [
    ReviewFindingDemoted.make({
      lens: "test",
      title: "naming",
      from: "Critical",
      to: "Warning",
      reason: "not in the diff",
      lane
    }),
    "1111",
    "a review finding demoted"
  ],
  ExecutorLeased: [
    ExecutorLeased.make({ executor: "codex", role: "coder" }),
    "0111",
    "a roster change"
  ],
  ExecutorReleased: [
    ExecutorReleased.make({ executor: "codex", role: "coder" }),
    "0000",
    "a roster change"
  ],
  ExecutorExcluded: [
    ExecutorExcluded.make({ executor: "codex", reason: "for this run" }),
    "0111",
    "a roster change"
  ],
  ExecutorResumed: [
    ExecutorResumed.make({ executor: "codex", why: "health" }),
    "0111",
    "a roster change"
  ],
  ExecutorHandedOver: [
    ExecutorHandedOver.make({ from: "codex", role: "coder", reason: "down", scope: "coder" }),
    "0111",
    "a roster change"
  ],
  StoryJudged: [
    StoryJudged.make({ lane, round: 1, cleared: true, issues: 0, dimensions: [] }),
    "0000",
    "a judge verdict"
  ],
  RoundtableTurn: [
    RoundtableTurn.make({
      lane,
      meeting: "payments-hub",
      item: 1,
      itemTitle: "Integration",
      round: 1,
      turn: 1,
      kind: "position",
      blocking: false,
      answers: [],
      summary: "Events."
    }),
    "0000",
    // Was "an event"; no profile lane held one before attendee lanes were profiled.
    "a roundtable turn"
  ],
  BriefReported: [
    BriefReported.make({
      lane,
      run: "r1",
      brief: "B1",
      title: "API",
      wave: 1,
      attempt: 1,
      status: "PASS",
      summary: "Done."
    }),
    "0000",
    // Was "an event"; no profile lane held one before specialist lanes were profiled.
    "a brief report"
  ],
  Timed: [
    Timed.make({ kind: "model", label: "coder", ms: 5, lane }),
    "0000",
    "the end of a coder call"
  ],
  Began: [Began.make({ kind: "model", label: "coder", lane }), "0000", "the start of a coder call"],
  TasksPlanned: [TasksPlanned.make({ tasks: [], lane }), "0000", "an event"],
  TaskStarted: [TaskStarted.make({ index: 1, count: 1, title: "t", lane }), "0000", "an event"],
  TaskCompleted: [TaskCompleted.make({ index: 1, count: 1, title: "t", lane }), "0000", "an event"],
  StoryStatusChanged: [
    StoryStatusChanged.make({ id: "home", status: "active" }),
    "0000",
    "an event"
  ],
  CriterionChecked: [
    CriterionChecked.make({ story: "home", tag: "[home#1]", status: "red", lane }),
    "0111",
    "an event"
  ],
  Parked: [
    Parked.make({ story: "home", item: "export", reason: "later", mvp: false, lane }),
    "0111",
    "an event"
  ]
}

const verbosities: ReadonlyArray<Verbosity> = ["Quiet", "Normal", "Verbose", "Debug"]
const prints = (event: FlowEvent): string =>
  verbosities.map((verbosity) => (rendersEvent(verbosity, event) ? "1" : "0")).join("")
const kindOf = (event: FlowEvent): string => {
  const { kind } = presentationOf(event)
  return typeof kind === "function" ? kind(event) : kind
}
const all = Object.values(cases)

describe("eventPresentation", () => {
  it("prints every event at the verbosities the rendersEvent switch did", () => {
    for (const [event, expected] of all) {
      assert.strictEqual(prints(event), expected, event._tag)
    }
    assert.strictEqual(prints(Began.make({ kind: "gate", label: "pnpm test" })), "0111")
    assert.strictEqual(prints(Began.make({ kind: "tool", label: "shell" })), "0000")
  })

  it("names every event for a profile gap as the describe switch did", () => {
    for (const [event, , expected] of all) {
      assert.strictEqual(kindOf(event), expected, event._tag)
    }
    const timed = (kind: Timed["kind"]) => kindOf(Timed.make({ kind, label: "L", ms: 1 }))
    const began = (kind: Began["kind"]) => kindOf(Began.make({ kind, label: "L" }))
    assert.deepStrictEqual(
      [timed("tool"), timed("gate"), timed("wait"), timed("git"), timed("merge"), timed("spawn")],
      [
        "the end of tool L",
        "the end of gate L",
        "the end of a wait for the L",
        "the end of L",
        "the end of L",
        "the end of L"
      ]
    )
    assert.deepStrictEqual(
      [began("tool"), began("gate"), began("wait"), began("git")],
      ["the start of tool L", "the start of gate L", "the start of wait L", "the start of git L"]
    )
  })

  it("digests the kinds an operator reads in a run's recent events", () => {
    assert.deepStrictEqual([...digestedTags].sort(), [
      "Aborted",
      "Began",
      "CapabilityUnenforceable",
      "CriterionChecked",
      "ExecutorExcluded",
      "ExecutorHandedOver",
      "Parked",
      "StageFailed",
      "StoryJudged",
      "StoryStatusChanged"
    ])
    assert.deepStrictEqual(presentationOf(cases.StageFailed[0]).digest?.(cases.StageFailed[0]), {
      text: "branch failed: red",
      lane: "home"
    })
    assert.deepStrictEqual(presentationOf(cases.Aborted[0]).digest?.(cases.Aborted[0]), {
      text: "aborted: stopped"
    })
  })
})

describe("laneOfEvent", () => {
  it("is laneOf for the twelve events the terminal keeps a lane row for, and nothing for the rest", () => {
    const onScreen = all.flatMap(([event]) => (laneOfEvent(event) === undefined ? [] : [event]))
    assert.deepStrictEqual(onScreen.map((event) => event._tag).sort(), [
      "AssistantMessage",
      "Info",
      "ReviewFindings",
      "StageCompleted",
      "StageFailed",
      "StageStarted",
      "TaskCompleted",
      "TaskStarted",
      "TasksPlanned",
      "TokensUsed",
      "ToolUse",
      "UsageProgress"
    ])
    for (const event of onScreen) {
      assert.deepStrictEqual(laneOfEvent(event), laneOf(event), event._tag)
    }
    const offScreen = all.flatMap(([event]) =>
      laneOf(event) !== undefined && laneOfEvent(event) === undefined ? [event._tag] : []
    )
    assert.deepStrictEqual(offScreen.sort(), [
      "Began",
      "BriefReported",
      "CriterionChecked",
      "EvidenceChecked",
      "Parked",
      "ReviewFindingDemoted",
      "RoundtableTurn",
      "StoryJudged",
      "Timed"
    ])
    assert.deepStrictEqual(
      laneOfEvent(StageStarted.make({ stage: "branch", lane: "home", executor: "codex" })),
      { lane: "home", executor: "codex" }
    )
    assert.isUndefined(laneOfEvent(StageStarted.make({ stage: "branch" })))
  })
})
