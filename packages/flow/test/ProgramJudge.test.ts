import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import {
  Dimension,
  DimensionScore,
  EvalResult,
  Sample,
  type Evaluator
} from "@llm4ts/core/eval/Eval"
import { makeEvaluator } from "@llm4ts/core/eval/Evaluator"
import { FlowEvents, makeCollectingFlowEvents } from "@llm4ts/flow/FlowEvents"
import type { GitToolShape } from "@llm4ts/flow/GitTool"
import { loadPack, type Pack } from "@llm4ts/flow/Pack"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"
import {
  groupFiles,
  judgeAllPrograms,
  unimplemented,
  withJudgment,
  type ProgramJudgeOptions
} from "@llm4ts/flow/ProgramJudge"
import { makeMemoryWorkspace } from "@llm4ts/flow/Workspace"
import { makeFakeJudgment } from "@llm4ts/core/judgment/FakeJudgment"
import { JudgmentBackendError } from "@llm4ts/core/judgment/Judgment"
import { origins, scoreAnswer } from "@llm4ts/core/judgment/Schemas"
import { dimensionQuestion } from "@llm4ts/core/eval/Judge"
import type { JudgmentMode } from "@llm4ts/flow/Judgment"

const dimensions = [
  Dimension.make({ name: "completeness", rubric: "Every rule appears.", maxScore: 2 })
]

const fullMarks = EvalResult.make({
  scores: [DimensionScore.make({ name: "completeness", score: 2, reasoning: "all rules" })],
  summary: "ok"
})

const subBar = EvalResult.make({
  scores: [DimensionScore.make({ name: "completeness", score: 1, reasoning: "missing VAT rule" })],
  summary: "gaps"
})

const testPack = (programFiles?: string): Effect.Effect<Pack, unknown> =>
  Effect.gen(function* () {
    const workspace = yield* makeMemoryWorkspace()
    yield* workspace.write(
      "pack/pack.md",
      [
        "# Pack: fixture",
        "",
        "source: cobol",
        ...(programFiles === undefined ? [] : [`program-files: ${programFiles}`]),
        ""
      ].join("\n")
    )
    return yield* loadPack(workspace, "pack")
  })

const recordingJudge = (
  result: EvalResult
): Effect.Effect<{ judge: Evaluator<Sample>; calls: Ref.Ref<ReadonlyArray<Sample>> }> =>
  Effect.map(Ref.make<ReadonlyArray<Sample>>([]), (calls) => ({
    calls,
    judge: makeEvaluator((sample) =>
      Ref.update(calls, (recorded) => [...recorded, sample]).pipe(Effect.as(result))
    )
  }))

const fakeGit = (
  changed: ReadonlyArray<string>,
  diffFor: (paths: ReadonlyArray<string>) => string
): GitToolShape => ({
  init: Effect.void,
  initBare: Effect.void,
  config: () => Effect.void,
  status: Effect.succeed(""),
  uncommittedFiles: Effect.succeed([]),
  currentBranch: Effect.succeed("main"),
  diff: Effect.succeed(""),
  diffAll: Effect.succeed(""),
  defaultBase: Effect.succeed("main"),
  diffVsBase: () => Effect.succeed(""),
  diffVsBaseScoped: (_base, paths) => Effect.succeed(diffFor(paths)),
  listFiles: () => Effect.succeed([]),
  changedFilesVsBase: () => Effect.succeed(changed),
  addRemote: () => Effect.void,
  checkout: () => Effect.void,
  checkoutOrCreate: () => Effect.void,
  createBranch: () => Effect.die("unused"),
  commitAll: () => Effect.die("unused"),
  commitPaths: () => Effect.die("unused"),
  push: () => Effect.void,
  checkpoint: Effect.succeed("HEAD"),
  rollback: () => Effect.void,
  addWorktree: () => Effect.void,
  addWorktreeNewBranch: () => Effect.void,
  removeWorktree: () => Effect.void,
  moveWorktree: () => Effect.void,
  restorePaths: () => Effect.void,
  commitsAhead: () => Effect.succeed(0),
  mergeNoCommit: () => Effect.succeed([]),
  branchExists: () => Effect.succeed(false),
  deleteBranch: () => Effect.void,
  isAncestor: () => Effect.succeed(false),
  merge: () => Effect.void
})

const makeOptions = (
  overrides: Partial<ProgramJudgeOptions> & Pick<ProgramJudgeOptions, "pack" | "judge" | "git">
): Effect.Effect<ProgramJudgeOptions> =>
  Effect.map(makeMemoryPlainFileStore(), ({ store: files }) => ({
    dimensions,
    files,
    gateDir: "gate",
    base: "main",
    programs: [],
    specFor: (program) => Effect.succeed(`spec of ${program}`),
    query: "does the diff satisfy the spec?",
    ...overrides
  }))

describe("ProgramJudge.groupFiles", () => {
  it.effect("partitions changed files by program regex, multi-matches included", () =>
    Effect.gen(function* () {
      const pack = yield* testPack("src/.*<NAME>.*\\.java")
      const grouped = groupFiles(
        pack,
        ["Payroll", "Billing"],
        [
          "src/PayrollService.java",
          "src/BillingService.java",
          "src/PayrollBillingBridge.java",
          "build.gradle"
        ]
      )
      assert.deepStrictEqual(grouped.byProgram["Payroll"], [
        "src/PayrollService.java",
        "src/PayrollBillingBridge.java"
      ])
      assert.deepStrictEqual(grouped.byProgram["Billing"], [
        "src/BillingService.java",
        "src/PayrollBillingBridge.java"
      ])
      assert.deepStrictEqual(grouped.unassigned, ["build.gradle"])
    })
  )
})

describe("ProgramJudge.judgeAllPrograms", () => {
  const modes: ReadonlyArray<JudgmentMode | undefined> = [undefined, "observe", "advise", "act"]
  for (const mode of modes) {
    it.effect(
      `judgment ${mode ?? "default"} runs the appropriate evaluator and records dimension outcomes`,
      () =>
        Effect.gen(function* () {
          const events = yield* makeCollectingFlowEvents
          const pack = yield* testPack("src/<NAME>\\.java")
          const { judge, calls } = yield* recordingJudge(fullMarks)
          const fake = yield* makeFakeJudgment() // Score 0, disagreeing with full marks.
          const options = yield* makeOptions({
            pack,
            judge,
            git: fakeGit(["src/Payroll.java"], () => "diff"),
            programs: ["Payroll"],
            judgment: { judgment: fake.judgment, ...(mode === undefined ? {} : { mode }) }
          })
          const result = yield* judgeAllPrograms(options).pipe(
            Effect.provideService(FlowEvents, events)
          )
          assert.strictEqual(result.isClean, mode !== "act")
          assert.strictEqual((yield* Ref.get(calls)).length, mode === "act" ? 0 : 1)
          const requests = yield* fake.recorded
          assert.strictEqual(requests.length, 1)
          assert.deepStrictEqual(requests[0]?.state, {
            query: options.query,
            context: "spec of Payroll",
            response: "diff"
          })
          const recorded = yield* events.recorded
          const observations = recorded.filter((event) => event._tag === "JudgmentObserved")
          assert.strictEqual(observations.length, mode === "act" ? 0 : 1)
          if (mode !== "act") {
            assert.deepStrictEqual(observations[0]?.outcome, { _tag: "ProgramJudge", score: 2 })
            assert.strictEqual(observations[0]?.consumer, "program-judge")
            assert.strictEqual(observations[0]?.key, "completeness")
            assert.deepStrictEqual(observations[0]?.state, (yield* fake.recorded)[0]?.state)
            assert.deepStrictEqual(
              observations[0]?.question,
              (yield* fake.recorded)[0]?.questions["completeness"]
            )
            assert.strictEqual(observations[0]?.judgmentIdentity, fake.judgment.identity)
            assert.deepStrictEqual(
              observations[0]?.answer,
              scoreAnswer(
                dimensionQuestion(options.dimensions[0]),
                { "0": 1, "1": 0, "2": 0 },
                origins.fake()
              )
            )
            assert.strictEqual(observations[0]?.mode, mode ?? "observe")
            assert.strictEqual(observations[0]?.decision, "act")
            assert.strictEqual(observations[0]?.certainty, 1)
            assert.strictEqual(observations[0]?.support, 1)
            assert.deepStrictEqual(observations[0]?.origin, origins.fake())
          }
          const advice = recorded.filter(
            (event) => event._tag === "Info" && event.message.includes("judgment program-judge")
          )
          assert.strictEqual(advice.length, mode === "advise" ? 1 : 0)
          if (mode === "advise") {
            const first = advice[0]
            assert.match(first?._tag === "Info" ? first.message : "", /completeness.*act.*score.*2/)
          }
          // Identical reruns reuse the verdict, without fabricating new observations.
          yield* judgeAllPrograms(options).pipe(Effect.provideService(FlowEvents, events))
          assert.strictEqual((yield* fake.recorded).length, 1)
        })
    )
  }

  it.effect("invalidates judgment verdicts when mode or checkpoint changes", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const pack = yield* testPack("src/<NAME>\\.java")
      const { judge, calls } = yield* recordingJudge(fullMarks)
      const fake = yield* makeFakeJudgment()
      const options = yield* makeOptions({
        pack,
        judge,
        git: fakeGit(["src/Payroll.java"], () => "diff"),
        programs: ["Payroll"]
      })
      const acted = yield* judgeAllPrograms({
        ...options,
        judgment: { judgment: fake.judgment, mode: "act" }
      }).pipe(Effect.provideService(FlowEvents, events))
      const observed = yield* judgeAllPrograms({
        ...options,
        judgment: { judgment: fake.judgment }
      }).pipe(Effect.provideService(FlowEvents, events))
      assert.isFalse(acted.isClean)
      assert.isTrue(observed.isClean)
      yield* judgeAllPrograms({
        ...options,
        judgment: { judgment: { ...fake.judgment, identity: "new-checkpoint" } }
      }).pipe(Effect.provideService(FlowEvents, events))
      assert.strictEqual((yield* fake.recorded).length, 3)
      assert.strictEqual((yield* Ref.get(calls)).length, 2)
    })
  )

  it.effect("judges each active program against only its slice of the diff", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const pack = yield* testPack("src/<NAME>\\.java")
      const { judge, calls } = yield* recordingJudge(fullMarks)
      const git = fakeGit(
        ["src/Payroll.java", "src/Billing.java"],
        (paths) => `diff of ${paths.join(",")}`
      )
      const options = yield* makeOptions({
        pack,
        judge,
        git,
        programs: ["Payroll", "Billing"]
      })
      const result = yield* judgeAllPrograms(options).pipe(
        Effect.provideService(FlowEvents, events)
      )
      assert.isTrue(result.isClean)
      const samples = yield* Ref.get(calls)
      assert.strictEqual(samples.length, 2)
      assert.strictEqual(samples[0]?.response, "diff of src/Payroll.java")
      assert.strictEqual(samples[0]?.context, "spec of Payroll")
      assert.strictEqual(samples[1]?.response, "diff of src/Billing.java")
    })
  )

  it.effect("judges the unassigned remainder once, against every spec", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const pack = yield* testPack("src/<NAME>\\.java")
      const { judge, calls } = yield* recordingJudge(fullMarks)
      const git = fakeGit(
        ["src/Payroll.java", "build.gradle", "src/Shared.java"],
        (paths) => `diff of ${paths.join(",")}`
      )
      const options = yield* makeOptions({ pack, judge, git, programs: ["Payroll"] })
      yield* judgeAllPrograms(options).pipe(Effect.provideService(FlowEvents, events))
      const samples = yield* Ref.get(calls)
      assert.strictEqual(samples.length, 2)
      assert.strictEqual(samples[1]?.response, "diff of build.gradle,src/Shared.java")
      assert.strictEqual(samples[1]?.context, "spec of Payroll")
    })
  )

  it.effect("a spec'd program with no matching changed file is a Critical finding", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const pack = yield* testPack("src/<NAME>\\.java")
      const { judge, calls } = yield* recordingJudge(fullMarks)
      const git = fakeGit(["src/Payroll.java"], (paths) => `diff of ${paths.join(",")}`)
      const options = yield* makeOptions({
        pack,
        judge,
        git,
        programs: ["Payroll", "Ledger"]
      })
      const result = yield* judgeAllPrograms(options).pipe(
        Effect.provideService(FlowEvents, events)
      )
      assert.isFalse(result.isClean)
      const critical = result.issues.find((issue) =>
        issue.title.includes("judge[Ledger]: spec'd but no implementation files changed")
      )
      assert.isDefined(critical)
      assert.strictEqual(critical?.severity, "Critical")
      assert.include(critical?.description ?? "", "program-files")
      // Ledger was reported, not judged.
      assert.strictEqual((yield* Ref.get(calls)).length, 1)
    })
  )

  it.effect("turns sub-bar dimensions into Critical issues named for the program", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const pack = yield* testPack("src/<NAME>\\.java")
      const { judge } = yield* recordingJudge(subBar)
      const git = fakeGit(["src/Payroll.java"], () => "diff")
      const options = yield* makeOptions({ pack, judge, git, programs: ["Payroll"] })
      const result = yield* judgeAllPrograms(options).pipe(
        Effect.provideService(FlowEvents, events)
      )
      assert.strictEqual(result.issues.length, 1)
      assert.strictEqual(result.issues[0]?.title, "judge[Payroll]: completeness scored 1")
      assert.strictEqual(result.issues[0]?.description, "missing VAT rule")
    })
  )

  it.effect("reuses cached verdicts: unchanged content re-judges nothing", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const pack = yield* testPack("src/<NAME>\\.java")
      const { judge, calls } = yield* recordingJudge(fullMarks)
      const git = fakeGit(["src/Payroll.java"], () => "stable diff")
      const options = yield* makeOptions({ pack, judge, git, programs: ["Payroll"] })
      const first = yield* judgeAllPrograms(options).pipe(Effect.provideService(FlowEvents, events))
      const second = yield* judgeAllPrograms(options).pipe(
        Effect.provideService(FlowEvents, events)
      )
      assert.deepStrictEqual(second, first)
      assert.strictEqual((yield* Ref.get(calls)).length, 1)
    })
  )
})

describe("ProgramJudge.unimplemented", () => {
  it("is clean for an empty program list", () => {
    assert.isTrue(unimplemented([]).isClean)
  })
})

describe("ProgramJudge.withJudgment", () => {
  it.effect(
    "returns the complete generative result and observes each answered dimension, including held answers",
    () =>
      Effect.gen(function* () {
        const rubric = [
          Dimension.make({ name: "correctness", rubric: "Correct" }),
          Dimension.make({ name: "safety", rubric: "Safe" }),
          Dimension.make({ name: "missing", rubric: "Missing" })
        ]
        const result = EvalResult.make({
          scores: rubric.map((dimension) =>
            DimensionScore.make({ name: dimension.name, score: 2, reasoning: "generative reason" })
          ),
          summary: "generative summary"
        })
        const answer = scoreAnswer(
          dimensionQuestion(rubric[0] ?? Dimension.make({ name: "x", rubric: "x" })),
          { "0": 1 },
          origins.llm("logprobs"),
          0.1
        )
        const fake = yield* makeFakeJudgment({
          answers: { correctness: answer },
          failures: { missing: "no answer" }
        })
        const events = yield* makeCollectingFlowEvents
        const { judge } = yield* recordingJudge(result)
        const scored = yield* withJudgment(
          judge,
          rubric,
          { judgment: fake.judgment },
          events
        ).evaluate(Sample.make({ response: "diff" }))
        assert.strictEqual(scored, result)
        const observations = (yield* events.recorded).filter(
          (event) => event._tag === "JudgmentObserved"
        )
        assert.deepStrictEqual(
          observations.map((event) => event.key),
          ["correctness", "safety"]
        )
        assert.deepStrictEqual(
          observations.map((event) => event.outcome),
          [
            { _tag: "ProgramJudge", score: 2 },
            { _tag: "ProgramJudge", score: 2 }
          ]
        )
        assert.strictEqual(observations[0]?.decision, "hold")
        assert.strictEqual(observations[0]?.support, 0.1)
      })
  )

  it.effect(
    "keeps the generative result on backend failure in observe/advise, but propagates it in act",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakeJudgment()
        const broken = {
          ...fake.judgment,
          judge: () =>
            Effect.fail(JudgmentBackendError.make({ backend: "fake", message: "unavailable" }))
        }
        const events = yield* makeCollectingFlowEvents
        const { judge, calls } = yield* recordingJudge(fullMarks)
        for (const mode of ["observe", "advise", "act"] satisfies ReadonlyArray<JudgmentMode>) {
          const result = yield* withJudgment(judge, dimensions, { judgment: broken, mode }, events)
            .evaluate(Sample.make({ response: "diff" }))
            .pipe(Effect.result)
          if (result._tag === "Success") {
            assert.notStrictEqual(mode, "act")
            assert.strictEqual(result.success, fullMarks)
          } else {
            assert.strictEqual(mode, "act")
            assert.strictEqual(result.failure._tag, "ProviderError")
          }
        }
        assert.strictEqual((yield* Ref.get(calls)).length, 2)
        assert.isFalse((yield* events.recorded).some((event) => event._tag === "JudgmentObserved"))
      })
  )
})
