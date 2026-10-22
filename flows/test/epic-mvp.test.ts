import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { InvalidRequestError } from "@llm4ts/core/Errors"
import { unsupportedScoreLabels } from "@llm4ts/core/LabelScoring"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import { ConnectorCapabilities, LlmChunk } from "@llm4ts/core/Models"
import type { FlowContextShape } from "@llm4ts/flow/FlowContext"
import { FlowAborted, type FlowError } from "@llm4ts/flow/FlowError"
import { makeCollectingFlowEvents, type FlowEventsShape } from "@llm4ts/flow/FlowEvents"
import { Committed, type GitToolShape } from "@llm4ts/flow/GitTool"
import type { GitHubToolShape } from "@llm4ts/flow/GitHubTool"
import { makeMemoryPlainFileStore, saveVersioned } from "@llm4ts/flow/Persistence"
import { ReviewResult } from "@llm4ts/flow/Review"
import {
  EpicReport,
  RedTests,
  RedTestsVersion,
  StoryOutcome,
  redTestsPath,
  type StorySeats
} from "@llm4ts/flow/Stories"
import { Story, StoryPlan } from "@llm4ts/flow/StoryPlan"
import {
  checkMvpPlan,
  cutPath,
  epicMvpOptions,
  generateMvpPlan,
  greenTaskPlan,
  mvpAfterUnit,
  mvpBeforeLand,
  mvpIterateFeedback,
  mvpPreflight,
  mvpRedPhase,
  parkedPath,
  parseMvpFlags,
  verdictPath
} from "../lib/epic-mvp.ts"
import type { EpicUnitContext } from "../lib/epic-stories.ts"
import { loadRosterDocument } from "@llm4ts/runner/ExecutorRoster"

const unused = InvalidRequestError.make({ message: "unused in test" })
const unusedFlow: Effect.Effect<never, FlowError> = Effect.fail(
  FlowAborted.make({ message: "unused in test" })
)

/** A seat whose structured answer is `value` and whose chat replies `reply`, counting turns. */
const seat = (value: unknown, turns?: Ref.Ref<ReadonlyArray<string>>): LlmServiceShape => {
  const answer = (prompt: string) =>
    Stream.unwrap(
      Effect.map(
        turns === undefined ? Effect.void : Ref.update(turns, (all) => [...all, prompt]),
        () => Stream.make(LlmChunk.make({ delta: "done", finishReason: "stop" }))
      )
    )
  return {
    executeStream: answer,
    executeStreamWithHistory: (messages) => answer(messages.at(-1)?.content ?? ""),
    executeWithTools: () => Effect.fail(unused),
    executeStructured: (_prompt, schema) =>
      Schema.decodeUnknownEffect(schema)(value).pipe(Effect.orDie),
    executeStructuredWithUsage: (_prompt, schema) =>
      Schema.decodeUnknownEffect(schema)(value).pipe(
        Effect.orDie,
        Effect.map((decoded) => [decoded, undefined, undefined] as const)
      ),
    scoreLabels: unsupportedScoreLabels,
    isAvailable: Effect.succeed(true)
  }
}

const hosting: GitHubToolShape = {
  createPr: () => unusedFlow,
  readIssue: () => unusedFlow,
  readIssueComments: () => unusedFlow,
  writeIssueComment: () => unusedFlow,
  editIssueComment: () => unusedFlow,
  writePrComment: () => unusedFlow,
  updatePr: () => unusedFlow,
  prChecks: () => unusedFlow,
  viewOpenPr: unusedFlow,
  mergePr: () => unusedFlow,
  listIssues: () => unusedFlow,
  createIssue: () => unusedFlow,
  editIssueLabels: () => unusedFlow,
  assignIssue: () => unusedFlow,
  closeIssue: () => unusedFlow
}

const git = (uncommitted: ReadonlyArray<string>): GitToolShape => ({
  init: Effect.void,
  initBare: Effect.void,
  config: () => Effect.void,
  status: Effect.succeed(""),
  uncommittedFiles: Effect.succeed(uncommitted),
  currentBranch: Effect.succeed("story/e/conto"),
  diff: Effect.succeed(""),
  diffAll: Effect.succeed("diff --git a/src/conto/conto.test.ts b/src/conto/conto.test.ts"),
  defaultBase: Effect.succeed("main"),
  diffVsBase: () => Effect.succeed(""),
  diffVsBaseScoped: () => Effect.succeed(""),
  listFiles: () => Effect.succeed([]),
  changedFilesVsBase: () => Effect.succeed([]),
  addRemote: () => Effect.void,
  checkout: () => Effect.void,
  checkoutOrCreate: () => Effect.void,
  createBranch: () => unusedFlow,
  commitAll: () => Effect.succeed(Committed.make({})),
  commitPaths: () => Effect.succeed(Committed.make({})),
  push: () => Effect.void,
  checkpoint: Effect.succeed("red"),
  rollback: () => Effect.void,
  addWorktree: () => Effect.void,
  addWorktreeNewBranch: () => Effect.void,
  removeWorktree: () => Effect.void,
  moveWorktree: () => Effect.void,
  restorePaths: () => Effect.void,
  mergeNoCommit: () => Effect.succeed([]),
  branchExists: () => Effect.succeed(false),
  deleteBranch: () => Effect.void,
  isAncestor: () => Effect.succeed(true),
  merge: () => Effect.void
})

const conto = Story.make({
  id: "conto",
  title: "Current account",
  description: "Show the balance and the movements.",
  owned: ["src/conto"],
  acceptance: ["shows the balance", "lists the movements"],
  later: ["paginates movements"]
})

const plan = StoryPlan.make({ epicId: "e", epic: "Accounts.", stories: [conto] })

const junit = (cases: ReadonlyArray<readonly [string, boolean]>): string =>
  `<testsuites><testsuite>${cases
    .map(([name, passed]) =>
      passed
        ? `<testcase classname="c" name="${name}"/>`
        : `<testcase classname="c" name="${name}"><failure/></testcase>`
    )
    .join("")}</testsuite></testsuites>`

/** A unit whose test gate writes `report()` as the JUnit file under the app dir. */
const makeUnit = (report: Effect.Effect<string>, stateDir = "/repo/.llm4ts/epics/e") =>
  Effect.gen(function* () {
    const memory = yield* makeMemoryPlainFileStore()
    const collected = yield* makeCollectingFlowEvents
    const runs = yield* Ref.make(0)
    const unit: EpicUnitContext = {
      plan,
      stateDir,
      epicStateDir: "/repo/.llm4ts/epics/e",
      workDir: "/repo",
      appDir: ".",
      files: memory.store,
      events: collected,
      testGate: (workDir) =>
        Effect.gen(function* () {
          yield* Ref.update(runs, (count) => count + 1)
          yield* memory.store.writeAtomic(`${workDir}/junit.xml`, yield* report)
          return ReviewResult.make({ issues: [], summary: "" })
        })
    }
    return { unit, memory, collected, runs }
  })

const seatsWith = (
  coder: LlmServiceShape,
  reviewer: LlmServiceShape,
  events: FlowEventsShape,
  uncommitted: ReadonlyArray<string>
): StorySeats => {
  const context: FlowContextShape = {
    reasoning: reviewer,
    coder,
    git: git(uncommitted),
    hosting,
    events,
    reviewers: [reviewer],
    coderCapabilities: ConnectorCapabilities.make({}),
    userPrompt: "epic",
    workDir: "/wt/conto",
    workspace: "/repo"
  }
  return { context }
}

const cleanReview = { issues: [], summary: "clean" }
const source = { _tag: "Report", path: "junit.xml" } as const

describe("epic-mvp flags", () => {
  it("--iterate becomes epic-stories' --refine; --review is the flow's own", () => {
    assert.deepStrictEqual(parseMvpFlags(["--iterate", "--review", "--epic", "e"]), {
      iterate: true,
      review: true,
      argv: ["--refine", "--epic", "e"]
    })
    assert.deepStrictEqual(parseMvpFlags(["text"]).argv, ["text"])
  })

  it.effect("refuses to start without per-test evidence", () =>
    Effect.gen(function* () {
      const refused = yield* Effect.flip(mvpPreflight({}))
      assert.include(refused.message, "LLM4TS_TEST_REPORT")
      yield* mvpPreflight({ LLM4TS_TEST_REPORT: "junit.xml" })
    })
  )

  it("drops the story judge and every review lens unless --review", () => {
    const options = epicMvpOptions(parseMvpFlags([]), { LLM4TS_TEST_REPORT: "junit.xml" })
    assert.isUndefined(options.storyJudge)
    assert.isDefined(options.afterUnit)
  })
})

describe("epic-mvp plan", () => {
  it.effect("writes the MVP stories to the plan and the stories cut whole beside it", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      const events = yield* makeCollectingFlowEvents
      const generated = yield* generateMvpPlan({
        reasoning: seat({
          epicId: "ignored",
          epic: "ignored",
          stories: [
            {
              id: "conto",
              title: "Current account",
              description: "Balance.",
              dependsOn: [],
              owned: ["src/conto"],
              sharedReadOnly: [],
              readFirst: [],
              acceptance: ["shows the balance"],
              later: ["exports CSV"],
              provides: []
            }
          ],
          parked: [{ title: "Statements PDF", why: "not needed to move money" }]
        }),
        events,
        epic: "Accounts.",
        epicId: "e",
        guidance: "",
        brief: undefined,
        orientation: undefined,
        files: memory.store,
        stateDir: "/s"
      })
      assert.strictEqual(generated.epicId, "e")
      assert.deepStrictEqual(generated.stories[0]?.later, ["exports CSV"])
      const cut = (yield* memory.files)[cutPath("/s")] ?? ""
      assert.include(cut, "Statements PDF")
    })
  )

  it.effect("a story without an MVP outcome breaks the plan", () =>
    Effect.gen(function* () {
      yield* checkMvpPlan(plan)
      const broken = yield* Effect.flip(
        checkMvpPlan(
          StoryPlan.make({
            ...plan,
            stories: [Story.make({ ...conto, acceptance: [], later: ["all of it"] })]
          })
        )
      )
      assert.include(broken.message, "no MVP outcome")
    })
  )

  it.effect("one green task names every tag and what it satisfies", () =>
    Effect.gen(function* () {
      const tasks = yield* greenTaskPlan(
        seatsWith(seat(cleanReview), seat(cleanReview), yield* makeCollectingFlowEvents, []),
        conto,
        ""
      )
      assert.strictEqual(tasks.tasks.length, 1)
      assert.include(tasks.tasks[0]?.description ?? "", "[conto#2] lists the movements")
      assert.include(tasks.tasks[0]?.description ?? "", "Satisfies: 1, 2")
    })
  )
})

describe("epic-mvp red phase", () => {
  it.effect("tests reviewed once, proved red, frozen; an already-green outcome is parked", () =>
    Effect.gen(function* () {
      const { unit, memory, collected } = yield* makeUnit(
        Effect.succeed(junit([["[conto#1] shows the balance", true]]))
      )
      yield* memory.store.writeAtomic(
        "/wt/conto/src/conto/conto.test.ts",
        'it("[conto#1] shows the balance")\nit("[conto#2] lists the movements")'
      )
      const turns = yield* Ref.make<ReadonlyArray<string>>([])
      const reviewer = seat({
        issues: [{ severity: "Warning", title: "[conto#2] asserts nothing", description: "" }],
        summary: ""
      })
      const red = yield* mvpRedPhase(source, unit)(
        conto,
        seatsWith(seat(cleanReview, turns), reviewer, collected, [
          "src/conto/conto.test.ts",
          "src/conto/index.ts"
        ]),
        "/wt/conto",
        "system",
        collected
      )
      assert.deepStrictEqual(red.frozen, ["src/conto/conto.test.ts"])
      assert.strictEqual(red.parked.length, 1)
      assert.include(red.parked[0] ?? "", "[conto#1]")
      const asked = yield* Ref.get(turns)
      assert.strictEqual(asked.length, 2)
      assert.include(asked[0] ?? "", "MUST FAIL now")
      assert.include(asked[1] ?? "", "asserts nothing")
      const checked = (yield* collected.recorded).flatMap((event) =>
        event._tag === "CriterionChecked" ? [`${event.tag}:${event.status}`] : []
      )
      // #2 is written but absent from the report (its suite cannot load yet): red.
      assert.deepStrictEqual(checked, ["[conto#1]:green", "[conto#2]:red"])
    })
  )

  it.effect("a test report git can see stops the run, and is removed", () =>
    Effect.gen(function* () {
      const { unit, memory, collected } = yield* makeUnit(
        Effect.succeed(junit([["[conto#1] shows the balance", false]]))
      )
      const aborted = yield* Effect.flip(
        mvpRedPhase(source, unit)(
          conto,
          seatsWith(seat(cleanReview), seat(cleanReview), collected, [
            "src/conto/conto.test.ts",
            "junit.xml"
          ]),
          "/wt/conto",
          "system",
          collected
        )
      )
      assert.include(aborted.message, "not git-ignored")
      assert.isUndefined((yield* memory.files)["/wt/conto/junit.xml"])
    })
  )

  it.effect("an outcome no test names after a second turn fails the story", () =>
    Effect.gen(function* () {
      const { unit, collected } = yield* makeUnit(Effect.succeed(junit([])))
      const failed = yield* Effect.flip(
        mvpRedPhase(source, unit)(
          conto,
          seatsWith(seat(cleanReview), seat(cleanReview), collected, []),
          "/wt/conto",
          "system",
          collected
        )
      )
      assert.strictEqual(failed._tag, "StoryFailed")
      assert.include(failed.message, "[conto#1], [conto#2]")
    })
  )
})

describe("epic-mvp verdict", () => {
  const done = EpicReport.make({
    epicId: "e",
    epicBranch: "epic/e",
    estimated: true,
    stories: [StoryOutcome.make({ id: "conto", title: "Current account", status: "done" })]
  })

  it.effect("MVP reached when every outcome is green on the epic; later items are parked", () =>
    Effect.gen(function* () {
      const { unit, memory } = yield* makeUnit(
        Effect.succeed(
          junit([
            ["[conto#1] shows the balance", true],
            ["[conto#2] lists the movements", true]
          ])
        )
      )
      yield* memory.store.writeAtomic(
        cutPath(unit.stateDir),
        JSON.stringify([{ title: "Statements PDF", why: "later" }])
      )
      yield* saveVersioned(
        memory.store,
        redTestsPath(unit.stateDir, "conto"),
        RedTestsVersion,
        RedTests,
        RedTests.make({ frozen: [], commit: "red", parked: [] })
      )
      yield* mvpAfterUnit(source)(unit, done)
      const files = yield* memory.files
      assert.include(files[verdictPath(unit.stateDir)] ?? "", '"reached":true')
      const parked = files[parkedPath(unit.stateDir)] ?? ""
      assert.include(parked, "paginates movements")
      assert.include(parked, "Statements PDF")
      // Reached: the landing goes ahead.
      yield* mvpBeforeLand(unit.stateDir, memory.store)
    })
  )

  it.effect("a red outcome or an unfinished story: MVP not reached, and --land refuses", () =>
    Effect.gen(function* () {
      const { unit, memory } = yield* makeUnit(
        Effect.succeed(
          junit([
            ["[conto#1] shows the balance", true],
            ["[conto#2] lists the movements", false]
          ])
        )
      )
      yield* memory.store.writeAtomic(`${unit.stateDir}/plan.md`, "plan")
      yield* mvpAfterUnit(source)(unit, done)
      const files = yield* memory.files
      assert.include(files[verdictPath(unit.stateDir)] ?? "", '"reached":false')
      assert.include(files[parkedPath(unit.stateDir)] ?? "", "[conto#2] lists the movements")
      const refused = yield* Effect.flip(mvpBeforeLand(unit.stateDir, memory.store))
      assert.include(refused.message, "MVP is not reached")

      const failedRun = EpicReport.make({
        ...done,
        stories: [
          StoryOutcome.make({
            id: "conto",
            title: "Current account",
            status: "failed",
            reason: "gates red"
          })
        ]
      })
      yield* mvpAfterUnit(source)(unit, failedRun)
      const after = (yield* memory.files)[parkedPath(unit.stateDir)] ?? ""
      assert.include(after, "story failed: gates red")
    })
  )

  it.effect("--land refuses an epic with no verdict yet", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      const refused = yield* Effect.flip(mvpBeforeLand("/s", memory.store))
      assert.include(refused.message, "no MVP verdict")
    })
  )

  it.effect("--iterate plans the parked lists, or only what the text promotes", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      yield* memory.store.writeAtomic(parkedPath("/s"), "- **conto** — paginates movements")
      const all = yield* mvpIterateFeedback("/s", "", memory.store)
      assert.include(all, "Plan every parked item")
      assert.include(all, "paginates movements")
      const some = yield* mvpIterateFeedback("/s", "only pagination", memory.store)
      assert.include(some, "only pagination")
      const none = yield* mvpIterateFeedback("/t", "free text", memory.store)
      assert.strictEqual(none, "free text")
    })
  )
})

describe("epic-mvp example roster", () => {
  it.effect("parses, with a high-effort planner and a low-effort reviewer", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      const text = readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "../../examples/epic-mvp.roster.json"),
        "utf8"
      )
      yield* memory.store.writeAtomic("/cfg/roster.json", text)
      const document = yield* loadRosterDocument({
        files: memory.store,
        environment: { HOME: "/home/me", LLM4TS_ROSTER: "/cfg/roster.json" },
        workDir: "/repo"
      })
      const planner = document?.executors.find((executor) => executor.id === "claude-planner")
      assert.strictEqual(planner?.effort, "high")
      const reviewer = document?.executors.find((executor) => executor.id === "claude-reviewer")
      assert.strictEqual(reviewer?.effort, "low")
    })
  )
})
