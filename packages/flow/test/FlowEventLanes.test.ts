import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { TokenUsage } from "@llm4ts/core/Models"
import { Board } from "@llm4ts/core/blackboard/Fact"
import { RunResult } from "@llm4ts/core/blackboard/Run"
import { origins, truth, truthAnswer } from "@llm4ts/core/judgment/Schemas"
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
  Declassified,
  EvidenceChecked,
  ExecutorExcluded,
  ExecutorHandedOver,
  ExecutorLeased,
  ExecutorReleased,
  ExecutorResumed,
  type FlowEvent,
  Info,
  JudgmentObserved,
  type Lane,
  Parked,
  ReviewFinding,
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
  eventLanes,
  laneClosed,
  laneOf,
  laneOpened,
  makeCollectingFlowEvents,
  withLane
} from "@llm4ts/flow/FlowEvents"

type Tag = FlowEvent["_tag"]
type EventOf<K extends Tag> = Extract<FlowEvent, { readonly _tag: K }>

const usage = TokenUsage.make({ prompt: 10, completion: 5, total: 15 })
const issues = [ReviewFinding.make({ severity: "Warning", title: "naming", file: "a.ts", line: 3 })]
const tasks = [{ title: "Add multiply", completed: false, satisfies: [1] }]

/** A lane with everything a coder's lane carries, and one with only its id. */
const full: Lane = {
  lane: "home",
  executor: Effect.succeed("codex"),
  clone: Effect.succeed(2),
  workDir: "/wt/home"
}
const bare: Lane = { lane: "home" }

/**
 * One instance of every event, published without a lane, and what `withLane`
 * makes of it on the full lane and on the bare one. No `stamped` entry: the
 * event comes out as the same object. Captured from the `stamped` switch
 * before `eventLanes` replaced it.
 */
const cases: {
  readonly [K in Tag]: {
    readonly event: EventOf<K>
    readonly stamped?: { readonly full: EventOf<K>; readonly bare: EventOf<K> }
  }
} = {
  JudgmentObserved: {
    event: JudgmentObserved.make({
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
    })
  },
  BlackboardRun: {
    event: BlackboardRun.make({
      ruleset: "story-board",
      result: RunResult.make({ board: Board.empty, trace: [], failures: [] })
    })
  },
  StageStarted: {
    event: StageStarted.make({ stage: "branch" }),
    stamped: {
      full: StageStarted.make({ stage: "branch", lane: "home", executor: "codex" }),
      bare: StageStarted.make({ stage: "branch", lane: "home" })
    }
  },
  StageCompleted: {
    event: StageCompleted.make({ stage: "branch" }),
    stamped: {
      full: StageCompleted.make({ stage: "branch", lane: "home", executor: "codex" }),
      bare: StageCompleted.make({ stage: "branch", lane: "home" })
    }
  },
  StageFailed: {
    event: StageFailed.make({ stage: "branch", message: "red" }),
    stamped: {
      full: StageFailed.make({ stage: "branch", message: "red", lane: "home", executor: "codex" }),
      bare: StageFailed.make({ stage: "branch", message: "red", lane: "home" })
    }
  },
  Aborted: { event: Aborted.make({ message: "stopped" }) },
  Info: {
    event: Info.make({ message: "hello" }),
    stamped: {
      full: Info.make({ message: "hello", lane: "home", executor: "codex" }),
      bare: Info.make({ message: "hello", lane: "home" })
    }
  },
  ToolUse: {
    event: ToolUse.make({
      tool: "shell",
      args: "cd /wt/home && cat /wt/home/src/a.ts",
      parent: "call-1"
    }),
    stamped: {
      full: ToolUse.make({
        tool: "shell",
        args: "cat src/a.ts",
        parent: "call-1",
        lane: "home",
        executor: "codex"
      }),
      bare: ToolUse.make({
        tool: "shell",
        args: "cd /wt/home && cat /wt/home/src/a.ts",
        parent: "call-1",
        lane: "home"
      })
    }
  },
  AssistantMessage: {
    event: AssistantMessage.make({ text: "done" }),
    stamped: {
      full: AssistantMessage.make({ text: "done", lane: "home", executor: "codex" }),
      bare: AssistantMessage.make({ text: "done", lane: "home" })
    }
  },
  TokensUsed: {
    event: TokensUsed.make({ agent: "coder", model: "m-1", usage }),
    stamped: {
      full: TokensUsed.make({
        agent: "coder",
        model: "m-1",
        usage,
        lane: "home",
        executor: "codex",
        clone: 2
      }),
      bare: TokensUsed.make({ agent: "coder", model: "m-1", usage, lane: "home" })
    }
  },
  UsageProgress: {
    event: UsageProgress.make({ call: "c1", usage, done: true }),
    stamped: {
      full: UsageProgress.make({
        call: "c1",
        usage,
        done: true,
        lane: "home",
        executor: "codex"
      }),
      bare: UsageProgress.make({ call: "c1", usage, done: true, lane: "home" })
    }
  },
  ReviewFindings: {
    event: ReviewFindings.make({ round: 1, settled: false, issues, diffLines: 40 }),
    stamped: {
      // The diff size travels with the stamp: `llm4ts profile` reads it off
      // the laned event, and the old switch dropped it.
      full: ReviewFindings.make({
        round: 1,
        settled: false,
        issues,
        diffLines: 40,
        lane: "home",
        executor: "codex"
      }),
      bare: ReviewFindings.make({ round: 1, settled: false, issues, diffLines: 40, lane: "home" })
    }
  },
  CapabilityUsed: {
    event: CapabilityUsedEvent.make({ capability: "git", operation: "status" })
  },
  CapabilityDenied: {
    event: CapabilityDeniedEvent.make({ capability: "git", operation: "push" })
  },
  CapabilityUnenforceable: { event: CapabilityUnenforceable.make({ detail: "by rule" }) },
  EvidenceChecked: {
    event: EvidenceChecked.make({ task: "Add multiply", claimed: 2, unverified: 1 })
  },
  ReviewFindingDemoted: {
    event: ReviewFindingDemoted.make({
      lens: "test",
      title: "naming",
      from: "Critical",
      to: "Warning",
      reason: "not in the diff"
    })
  },
  Declassified: { event: Declassified.make({ label: "plan" }) },
  ExecutorLeased: { event: ExecutorLeased.make({ executor: "codex", role: "coder", clone: 1 }) },
  ExecutorReleased: { event: ExecutorReleased.make({ executor: "codex", role: "coder" }) },
  ExecutorExcluded: {
    event: ExecutorExcluded.make({ executor: "codex", reason: "for this run" })
  },
  ExecutorResumed: { event: ExecutorResumed.make({ executor: "codex", why: "health" }) },
  ExecutorHandedOver: {
    event: ExecutorHandedOver.make({
      from: "codex",
      role: "coder",
      reason: "down",
      scope: "coder"
    })
  },
  StoryJudged: {
    event: StoryJudged.make({ lane: "list", round: 1, cleared: true, issues: 0, dimensions: [] })
  },
  RoundtableTurn: {
    event: RoundtableTurn.make({
      lane: "Cloud Architect",
      meeting: "payments-hub",
      item: 1,
      itemTitle: "Integration",
      round: 1,
      turn: 1,
      kind: "position",
      blocking: false,
      answers: [],
      summary: "Events."
    })
  },
  BriefReported: {
    event: BriefReported.make({
      lane: "Backend Engineer",
      run: "r1",
      brief: "B1",
      title: "API",
      wave: 1,
      attempt: 1,
      status: "PASS",
      summary: "Done."
    })
  },
  Timed: {
    event: Timed.make({
      kind: "model",
      label: "coder",
      ms: 1_200,
      firstMs: 300,
      apiMs: 900,
      toolMs: 100,
      exitCode: 0,
      category: "edit",
      failed: false
    }),
    stamped: {
      full: Timed.make({
        kind: "model",
        label: "coder",
        ms: 1_200,
        firstMs: 300,
        apiMs: 900,
        toolMs: 100,
        exitCode: 0,
        category: "edit",
        failed: false,
        lane: "home",
        executor: "codex"
      }),
      bare: Timed.make({
        kind: "model",
        label: "coder",
        ms: 1_200,
        firstMs: 300,
        apiMs: 900,
        toolMs: 100,
        exitCode: 0,
        category: "edit",
        failed: false,
        lane: "home"
      })
    }
  },
  Began: {
    event: Began.make({ kind: "model", label: "coder" }),
    stamped: {
      full: Began.make({ kind: "model", label: "coder", lane: "home", executor: "codex" }),
      bare: Began.make({ kind: "model", label: "coder", lane: "home" })
    }
  },
  TasksPlanned: {
    event: TasksPlanned.make({ tasks }),
    stamped: {
      full: TasksPlanned.make({ tasks, lane: "home", executor: "codex" }),
      bare: TasksPlanned.make({ tasks, lane: "home" })
    }
  },
  TaskStarted: {
    event: TaskStarted.make({ index: 1, count: 2, title: "Add multiply", satisfies: [1, 3] }),
    stamped: {
      full: TaskStarted.make({
        index: 1,
        count: 2,
        title: "Add multiply",
        satisfies: [1, 3],
        lane: "home",
        executor: "codex"
      }),
      bare: TaskStarted.make({
        index: 1,
        count: 2,
        title: "Add multiply",
        satisfies: [1, 3],
        lane: "home"
      })
    }
  },
  TaskCompleted: {
    event: TaskCompleted.make({ index: 1, count: 2, title: "Add multiply" }),
    stamped: {
      full: TaskCompleted.make({
        index: 1,
        count: 2,
        title: "Add multiply",
        lane: "home",
        executor: "codex"
      }),
      bare: TaskCompleted.make({ index: 1, count: 2, title: "Add multiply", lane: "home" })
    }
  },
  StoryStatusChanged: { event: StoryStatusChanged.make({ id: "home", status: "active" }) },
  CriterionChecked: {
    event: CriterionChecked.make({ story: "home", tag: "[home#1]", status: "red" })
  },
  Parked: {
    event: Parked.make({ story: "home", item: "export", reason: "later", mvp: false })
  }
}

/** The same events as a producer that already named a lane published them. */
const alreadyLaned: ReadonlyArray<FlowEvent> = [
  StageStarted.make({ stage: "branch", lane: "other", executor: "pi" }),
  StageCompleted.make({ stage: "branch", lane: "other" }),
  StageFailed.make({ stage: "branch", message: "red", lane: "other" }),
  Info.make({ message: "hello", lane: "other" }),
  ToolUse.make({ tool: "shell", args: "cd /wt/home && ls /wt/home/src", lane: "other" }),
  AssistantMessage.make({ text: "done", lane: "other" }),
  TokensUsed.make({ agent: "coder", usage, lane: "other" }),
  UsageProgress.make({ call: "c1", lane: "other" }),
  ReviewFindings.make({ round: 1, settled: true, issues, lane: "other", diffLines: 40 }),
  Timed.make({ kind: "tool", label: "shell", ms: 5, lane: "other" }),
  Began.make({ kind: "model", label: "coder", lane: "other" }),
  TasksPlanned.make({ tasks, lane: "other" }),
  TaskStarted.make({ index: 1, count: 2, title: "Add multiply", lane: "other" }),
  TaskCompleted.make({ index: 1, count: 2, title: "Add multiply", lane: "other" }),
  EvidenceChecked.make({ task: "Add multiply", claimed: 2, unverified: 1, lane: "other" }),
  ReviewFindingDemoted.make({
    lens: "test",
    title: "naming",
    from: "Critical",
    to: "Warning",
    reason: "not in the diff",
    lane: "other"
  }),
  CriterionChecked.make({ story: "home", tag: "[home#1]", status: "red", lane: "other" }),
  Parked.make({ story: "home", item: "export", reason: "later", mvp: false, lane: "other" })
]

const through = (lane: Lane, event: FlowEvent): Effect.Effect<FlowEvent | undefined> =>
  Effect.gen(function* () {
    const collecting = yield* makeCollectingFlowEvents
    yield* withLane(collecting, lane).publish(event)
    return (yield* collecting.recorded)[0]
  })

const allCases = Object.values(cases)

describe("withLane stamps each event as the stamped switch did", () => {
  it("covers the fourteen events it stamps and leaves the other twenty alone", () => {
    assert.strictEqual(allCases.length, 34)
    assert.strictEqual(allCases.filter((entry) => entry.stamped !== undefined).length, 14)
  })

  it.effect("an unlaned event of every tag, on a lane with executor, clone and workDir", () =>
    Effect.gen(function* () {
      for (const entry of allCases) {
        const published = yield* through(full, entry.event)
        if (entry.stamped === undefined) {
          assert.strictEqual(published, entry.event, entry.event._tag)
        } else {
          assert.deepStrictEqual(published, entry.stamped.full, entry.event._tag)
        }
      }
    })
  )

  it.effect("an unlaned event of every tag, on a lane with only its id", () =>
    Effect.gen(function* () {
      for (const entry of allCases) {
        const published = yield* through(bare, entry.event)
        if (entry.stamped === undefined) {
          assert.strictEqual(published, entry.event, entry.event._tag)
        } else {
          assert.deepStrictEqual(published, entry.stamped.bare, entry.event._tag)
        }
      }
    })
  )

  it.effect("an event that already names a lane is the same object afterwards", () =>
    Effect.gen(function* () {
      for (const event of alreadyLaned) {
        assert.strictEqual(yield* through(full, event), event, event._tag)
        assert.strictEqual(yield* through(bare, event), event, event._tag)
      }
    })
  )

  it.effect("a parallel task keeps its own coder and clone", () =>
    Effect.gen(function* () {
      const aside = TaskStarted.make({
        index: 2,
        count: 3,
        title: "Docs",
        parallel: true,
        executor: "pi",
        clone: 4
      })
      assert.deepStrictEqual(
        yield* through(full, aside),
        TaskStarted.make({
          index: 2,
          count: 3,
          title: "Docs",
          parallel: true,
          executor: "pi",
          clone: 4,
          lane: "home"
        })
      )
      assert.deepStrictEqual(
        yield* through(
          full,
          TaskStarted.make({ index: 2, count: 3, title: "Docs", parallel: false })
        ),
        TaskStarted.make({
          index: 2,
          count: 3,
          title: "Docs",
          parallel: false,
          lane: "home",
          executor: "codex"
        })
      )
    })
  )

  it.effect("tool arguments lose the lane's directory, and only that", () =>
    Effect.gen(function* () {
      const call = ToolUse.make({ tool: "read", args: "/wt/home/src/a.ts and /wt/homework/b.ts" })
      assert.deepStrictEqual(
        yield* through(full, call),
        ToolUse.make({
          tool: "read",
          args: "src/a.ts and /wt/homework/b.ts",
          lane: "home",
          executor: "codex"
        })
      )
      assert.deepStrictEqual(
        yield* through({ lane: "home", workDir: "/wt/home///" }, call),
        ToolUse.make({ tool: "read", args: "src/a.ts and /wt/homework/b.ts", lane: "home" })
      )
      assert.deepStrictEqual(
        yield* through({ lane: "home", workDir: "" }, call),
        ToolUse.make({
          tool: "read",
          args: "/wt/home/src/a.ts and /wt/homework/b.ts",
          lane: "home"
        })
      )
    })
  )

  it.effect("only the coder's token report gets the clone", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* through(full, TokensUsed.make({ agent: "reviewer", usage })),
        TokensUsed.make({ agent: "reviewer", usage, lane: "home", executor: "codex" })
      )
      assert.deepStrictEqual(
        yield* through(
          { lane: "home", clone: Effect.succeed(3) },
          TokensUsed.make({ agent: "coder", usage })
        ),
        TokensUsed.make({ agent: "coder", usage, lane: "home", clone: 3 })
      )
      assert.deepStrictEqual(
        yield* through(
          { lane: "home", executor: Effect.succeed("codex"), clone: Effect.succeed(undefined) },
          TokensUsed.make({ agent: "coder", usage })
        ),
        TokensUsed.make({ agent: "coder", usage, lane: "home", executor: "codex" })
      )
    })
  )

  it.effect("a timing gets the executor only for a coder call or a tool", () =>
    Effect.gen(function* () {
      const timed = (kind: Timed["kind"], label: string) => Timed.make({ kind, label, ms: 7 })
      const expectations: ReadonlyArray<readonly [Timed, boolean]> = [
        [timed("model", "coder"), true],
        [timed("model", "reviewer"), false],
        [timed("tool", "shell"), true],
        [timed("gate", "pnpm test"), false],
        [timed("git", "commitAll"), false],
        [timed("merge", "merge"), false],
        [timed("wait", "merge lock"), false],
        [timed("spawn", "coder"), false]
      ]
      for (const [event, named] of expectations) {
        assert.deepStrictEqual(
          yield* through(full, event),
          Timed.make({
            kind: event.kind,
            label: event.label,
            ms: 7,
            lane: "home",
            ...(named ? { executor: "codex" } : {})
          }),
          `${event.kind} ${event.label}`
        )
      }
    })
  )

  it.effect("a start gets the executor only for a coder call", () =>
    Effect.gen(function* () {
      const expectations: ReadonlyArray<readonly [Began, boolean]> = [
        [Began.make({ kind: "model", label: "coder" }), true],
        [Began.make({ kind: "model", label: "judge" }), false],
        [Began.make({ kind: "tool", label: "shell" }), false],
        [Began.make({ kind: "gate", label: "pnpm test" }), false]
      ]
      for (const [event, named] of expectations) {
        assert.deepStrictEqual(
          yield* through(full, event),
          Began.make({
            kind: event.kind,
            label: event.label,
            lane: "home",
            ...(named ? { executor: "codex" } : {})
          }),
          `${event.kind} ${event.label}`
        )
      }
    })
  )
})

describe("laneOf", () => {
  const structural = (event: FlowEvent): string | undefined =>
    "lane" in event && typeof event.lane === "string" ? event.lane : undefined

  it('is the lane of exactly the events that have one, as `"lane" in event` read it', () => {
    const events = [
      ...allCases.flatMap((entry) =>
        entry.stamped === undefined ? [entry.event] : [entry.event, entry.stamped.full]
      ),
      ...alreadyLaned
    ]
    for (const event of events) {
      assert.strictEqual(laneOf(event)?.lane, structural(event), event._tag)
    }
    assert.deepStrictEqual(laneOf(cases.Info.stamped?.full ?? cases.Info.event), {
      lane: "home",
      executor: "codex"
    })
    assert.deepStrictEqual(laneOf(cases.StoryJudged.event), { lane: "list" })
  })

  it("the table says which events withLane stamps, which carry a producer's lane, and which have none", () => {
    const by = (lane: "none" | "carried" | "stamped"): ReadonlyArray<string> =>
      Object.entries(eventLanes)
        .filter(([, rule]) => rule.lane === lane)
        .map(([tag]) => tag)
        .sort()
    assert.deepStrictEqual(
      by("stamped"),
      allCases
        .filter((entry) => entry.stamped !== undefined)
        .map((entry) => entry.event._tag)
        .sort()
    )
    assert.deepStrictEqual(by("carried"), [
      "BriefReported",
      "CriterionChecked",
      "EvidenceChecked",
      "Parked",
      "ReviewFindingDemoted",
      "RoundtableTurn",
      "StoryJudged"
    ])
    assert.strictEqual(by("none").length, 13)
  })
})

describe("the lane protocol", () => {
  it("a lane opens on the stage named after its kind and id, with that id as its lane", () => {
    assert.deepStrictEqual(laneOpened(StageStarted.make({ stage: "story home", lane: "home" })), {
      kind: "story",
      id: "home"
    })
    assert.deepStrictEqual(
      laneOpened(StageStarted.make({ stage: "attendee Cloud Architect", lane: "Cloud Architect" })),
      { kind: "attendee", id: "Cloud Architect" }
    )
    assert.deepStrictEqual(
      laneOpened(StageStarted.make({ stage: "specialist Backend", lane: "Backend" })),
      { kind: "specialist", id: "Backend" }
    )
  })

  it("no lane opens on a stage inside a lane, a run-wide stage, or another event", () => {
    assert.isUndefined(laneOpened(StageStarted.make({ stage: "story home: setup", lane: "home" })))
    assert.isUndefined(laneOpened(StageStarted.make({ stage: "story plan" })))
    assert.isUndefined(laneOpened(StageStarted.make({ stage: "B1: API", lane: "Backend" })))
    assert.isUndefined(laneOpened(StageCompleted.make({ stage: "story home", lane: "home" })))
  })

  it("it closes on the same stage completing or failing", () => {
    assert.deepStrictEqual(laneClosed(StageCompleted.make({ stage: "story home", lane: "home" })), {
      kind: "story",
      id: "home",
      failed: false
    })
    assert.deepStrictEqual(
      laneClosed(
        StageFailed.make({ stage: "specialist Backend", message: "red", lane: "Backend" })
      ),
      { kind: "specialist", id: "Backend", failed: true }
    )
    assert.isUndefined(
      laneClosed(StageCompleted.make({ stage: "story home: setup", lane: "home" }))
    )
    assert.isUndefined(laneClosed(StageStarted.make({ stage: "story home", lane: "home" })))
  })
})
