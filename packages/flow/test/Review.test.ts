import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { InvalidRequestError, ParseError } from "@llm4ts/core/Errors"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import { LlmChunk, TokenUsage } from "@llm4ts/core/Models"
import { makeChat } from "@llm4ts/flow/Chat"
import { ProcessError } from "@llm4ts/flow/FlowError"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"
import { makeCollectingFlowEvents, ReviewFinding } from "@llm4ts/flow/FlowEvents"
import { Reviewer } from "@llm4ts/flow/Pack"
import {
  ReviewIssue,
  ReviewResult,
  adversarialReviewer,
  applyTriage,
  demoteUnplaced,
  fixPrompt,
  lensPrompt,
  lintCommand,
  llmDriven,
  loadRepoReviewRules,
  mergeVotes,
  minimalReviewers,
  reviewAndFixLoop,
  reviewRulesPreamble,
  tagLens
} from "@llm4ts/flow/Review"
import { GateBaseline } from "@llm4ts/flow/Gates"
import { ReviewMemory } from "@llm4ts/flow/Recheck"
import { diffChunks, remember } from "@llm4ts/flow/Recheck"
import { ProcessResult, makeProcessExecutor } from "@llm4ts/core/ProcessExecutor"
import * as Fiber from "effect/Fiber"
import { TestClock } from "effect/testing"
import { unsupportedScoreLabels } from "@llm4ts/core/LabelScoring"
import { makeFakeJudgment } from "@llm4ts/core/judgment/FakeJudgment"
import { JudgmentBackendError } from "@llm4ts/core/judgment/Judgment"
import { origins, truthAnswer } from "@llm4ts/core/judgment/Schemas"
import type { JudgmentMode } from "@llm4ts/flow/Judgment"
import { attr, kindAttribute } from "@llm4ts/flow/Spans"
import { recordingTracer } from "./support/RecordingTracer.ts"
import { callPurpose } from "@llm4ts/flow/Timing"

const unused = InvalidRequestError.make({ message: "unused" })

const reviewerService = (
  values: Ref.Ref<ReadonlyArray<unknown>>,
  calls: Ref.Ref<number>,
  usage?: TokenUsage,
  model?: string
): LlmServiceShape => {
  const next = <A, E, RD, RE>(schema: Schema.ConstraintCodec<A, E, RD, RE>) =>
    Ref.updateAndGet(calls, (count) => count + 1).pipe(
      Effect.andThen(
        Ref.modify(values, (current) => [
          current[0] ?? { issues: [], summary: "clean" },
          current.slice(1)
        ])
      ),
      Effect.flatMap((value) => Schema.decodeUnknownEffect(schema)(value).pipe(Effect.orDie))
    )
  return {
    executeStream: (_prompt) => Stream.empty,
    executeStreamWithHistory: (_messages) => Stream.empty,
    executeWithTools: (_prompt, _tools) => Effect.fail(unused),
    executeStructured: (_prompt, schema, _jsonSchema) => next(schema),
    // The review path asks for usage; a connector that reports none still
    // has to review, so the default fake leaves it undefined.
    executeStructuredWithUsage: (_prompt, schema, _jsonSchema) =>
      next(schema).pipe(Effect.map((value) => [value, usage, model] as const)),
    scoreLabels: unsupportedScoreLabels,
    isAvailable: Effect.succeed(true)
  }
}

const coderService = (asks: Ref.Ref<number>): LlmServiceShape => ({
  ...reviewerService(Ref.makeUnsafe<ReadonlyArray<unknown>>([]), Ref.makeUnsafe(0)),
  executeStreamWithHistory: (_messages) =>
    Stream.fromEffect(
      Ref.update(asks, (count) => count + 1).pipe(
        Effect.as(LlmChunk.make({ delta: "fixed", finishReason: "stop" }))
      )
    )
})

const lens = (files?: string, name = "correctness"): Reviewer =>
  Reviewer.make({
    name,
    systemPrompt: "Review correctness.",
    ...(files === undefined ? {} : { files })
  })

describe("reviewAndFixLoop", () => {
  it.effect(
    "keeps reviewing when observations have failed questions or an unavailable backend",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakeJudgment({ failures: { correctness: "no answer" } })
        const broken = {
          ...fake.judgment,
          judge: () =>
            Effect.fail(JudgmentBackendError.make({ backend: "fake", message: "unavailable" }))
        }
        for (const judgment of [fake.judgment, broken]) {
          const events = yield* makeCollectingFlowEvents
          const calls = yield* Ref.make(0)
          const asks = yield* Ref.make(0)
          const dirty = ReviewResult.make({
            issues: [ReviewIssue.make({ severity: "Critical", title: "bug" })]
          })
          const values = yield* Ref.make<ReadonlyArray<unknown>>([dirty])
          const coder = yield* makeChat(coderService(asks))
          const result = yield* reviewAndFixLoop({
            reviewers: [lens()],
            reviewerService: reviewerService(values, calls),
            coder,
            taskTitle: "task",
            currentDiff: Effect.succeed("diff"),
            events,
            maxRounds: 1,
            prescreen: { judgment }
          })
          assert.deepStrictEqual(result.issues, tagLens("correctness", dirty).issues)
          assert.strictEqual(yield* Ref.get(calls), 1)
          assert.isFalse(
            (yield* events.recorded).some((event) => event._tag === "JudgmentObserved")
          )
        }
      })
  )

  const modes: ReadonlyArray<JudgmentMode | undefined> = [undefined, "observe", "advise", "act"]
  for (const mode of modes) {
    it.effect(`pre-screen ${mode ?? "default"} preserves the appropriate review/fix path`, () =>
      Effect.gen(function* () {
        const answer = truthAnswer(0, origins.llm("logprobs"))
        const fake = yield* makeFakeJudgment({
          answers: { correctness: answer, security: answer }
        })
        const dirty = ReviewResult.make({
          issues: [
            ReviewIssue.make({ severity: "Critical", title: "missed guard" }),
            ReviewIssue.make({ severity: "Warning", title: "missing test" }),
            ReviewIssue.make({ severity: "Info", title: "unclear name" })
          ]
        })
        const values = yield* Ref.make<ReadonlyArray<unknown>>([dirty, { issues: [] }])
        const calls = yield* Ref.make(0)
        const asks = yield* Ref.make(0)
        const events = yield* makeCollectingFlowEvents
        const coder = yield* makeChat(coderService(asks))
        const result = yield* reviewAndFixLoop({
          reviewers: [lens(), lens(undefined, "security")],
          reviewerService: reviewerService(values, calls),
          coder,
          taskTitle: "task",
          currentDiff: Effect.succeed("diff"),
          events,
          parallelism: 1,
          prescreen: { judgment: fake.judgment, ...(mode === undefined ? {} : { mode }) }
        })
        assert.isTrue(result.isClean)
        assert.strictEqual(yield* Ref.get(calls), mode === "act" ? 0 : 4)
        assert.strictEqual(yield* Ref.get(asks), mode === "act" ? 0 : 1)
        assert.strictEqual((yield* fake.recorded).length, mode === "act" ? 1 : 2)
        const recorded = yield* events.recorded
        const observations = recorded.filter((event) => event._tag === "JudgmentObserved")
        assert.strictEqual(observations.length, mode === "act" ? 0 : 4)
        if (mode !== "act") {
          assert.deepStrictEqual(
            observations.map((event) => event.outcome),
            [
              {
                _tag: "ReviewPrescreen",
                lens: "correctness",
                issues: { Critical: 1, Warning: 1, Info: 1 }
              },
              {
                _tag: "ReviewPrescreen",
                lens: "security",
                issues: { Critical: 0, Warning: 0, Info: 0 }
              },
              {
                _tag: "ReviewPrescreen",
                lens: "correctness",
                issues: { Critical: 0, Warning: 0, Info: 0 }
              },
              {
                _tag: "ReviewPrescreen",
                lens: "security",
                issues: { Critical: 0, Warning: 0, Info: 0 }
              }
            ]
          )
          assert.strictEqual(observations[0]?.consumer, "review-prescreen")
          assert.strictEqual(observations[0]?.key, "correctness")
          assert.deepStrictEqual(observations[0]?.state, (yield* fake.recorded)[0]?.state)
          assert.deepStrictEqual(
            observations[0]?.question,
            (yield* fake.recorded)[0]?.questions["correctness"]
          )
          assert.strictEqual(observations[0]?.judgmentIdentity, fake.judgment.identity)
          assert.deepStrictEqual(observations[0]?.answer, answer)
          assert.strictEqual(observations[0]?.mode, mode ?? "observe")
          assert.strictEqual(observations[0]?.decision, "act")
          assert.strictEqual(observations[0]?.certainty, 1)
          assert.strictEqual(observations[0]?.support, 1)
          assert.deepStrictEqual(observations[0]?.origin, answer.origin)
        }
        const advice = recorded.filter(
          (event) => event._tag === "Info" && event.message.includes("judgment review-prescreen")
        )
        assert.strictEqual(advice.length, mode === "advise" ? 4 : 0)
        if (mode === "advise") {
          const first = advice[0]
          assert.match(first?._tag === "Info" ? first.message : "", /correctness.*act.*Critical.*1/)
        }
      })
    )
  }

  // Reviewer lenses are structured calls, and their usage went unpublished:
  // every flow whose cost is dominated by review reported none of it.
  it.effect("publishes what each round found: the issues being fixed, then what is left", () =>
    Effect.gen(function* () {
      const values = yield* Ref.make<ReadonlyArray<unknown>>([
        {
          issues: [
            {
              severity: "Warning",
              title: "quick action lacks a test",
              file: "src/features/home/HomeScreen.tsx"
            },
            {
              severity: "Critical",
              title: "profiloFeature missing from FEATURES",
              file: "src/App.tsx",
              line: 12
            }
          ],
          summary: "two"
        },
        { issues: [], summary: "clean" }
      ])
      const calls = yield* Ref.make(0)
      const asks = yield* Ref.make(0)
      const events = yield* makeCollectingFlowEvents
      const coder = yield* makeChat(coderService(asks))
      yield* reviewAndFixLoop({
        reviewers: [lens()],
        reviewerService: reviewerService(values, calls),
        coder,
        taskTitle: "task",
        currentDiff: Effect.succeed("diff"),
        events
      })
      const findings = (yield* events.recorded).flatMap((event) =>
        event._tag === "ReviewFindings" ? [event] : []
      )
      assert.deepStrictEqual(
        findings.map((event) => [event.round, event.settled, event.issues.length]),
        [
          [1, false, 2],
          [2, true, 0]
        ]
      )
      assert.deepStrictEqual(
        findings[0]?.issues[1],
        ReviewFinding.make({
          severity: "Critical",
          title: "profiloFeature missing from FEATURES",
          file: "src/App.tsx",
          line: 12
        })
      )
    })
  )

  it.effect("publishes the token usage each reviewer lens reported", () =>
    Effect.gen(function* () {
      const values = yield* Ref.make<ReadonlyArray<unknown>>([{ issues: [], summary: "clean" }])
      const calls = yield* Ref.make(0)
      const asks = yield* Ref.make(0)
      const events = yield* makeCollectingFlowEvents
      const coder = yield* makeChat(coderService(asks))
      yield* reviewAndFixLoop({
        reviewers: [lens()],
        reviewerService: reviewerService(
          values,
          calls,
          TokenUsage.make({ prompt: 400, completion: 60, total: 460 }),
          "gemini-2.5-pro"
        ),
        coder,
        taskTitle: "task",
        currentDiff: Effect.succeed("diff"),
        events
      })

      const tokens = (yield* events.recorded).filter((event) => event._tag === "TokensUsed")
      assert.strictEqual(tokens.length, 1)
      assert.strictEqual(tokens[0]?._tag === "TokensUsed" ? tokens[0].agent : undefined, "reviewer")
      assert.strictEqual(tokens[0]?._tag === "TokensUsed" ? tokens[0].usage.total : undefined, 460)
    })
  )

  // Changed files only narrow reviewer selection. A repository that cannot
  // answer (no such base ref, unrelated histories) must not cost a task that
  // already took half an hour — issue #8.
  it.effect("keeps reviewing when the changed-file lookup fails", () =>
    Effect.gen(function* () {
      const values = yield* Ref.make<ReadonlyArray<unknown>>([{ issues: [], summary: "clean" }])
      const calls = yield* Ref.make(0)
      const asks = yield* Ref.make(0)
      const events = yield* makeCollectingFlowEvents
      const coder = yield* makeChat(coderService(asks))
      const result = yield* reviewAndFixLoop({
        // A file-scoped reviewer still runs: an empty list means "unknown",
        // so every reviewer is asked rather than silently skipped.
        reviewers: [lens(".*\\.md$")],
        reviewerService: reviewerService(values, calls),
        coder,
        taskTitle: "task",
        currentDiff: Effect.succeed("diff"),
        changedFiles: Effect.fail(
          ProcessError.make({
            message: "git diff --name-only main...HEAD",
            detail: "fatal: ambiguous argument 'main...HEAD': unknown revision"
          })
        ),
        events,
        maxRounds: 1
      })

      assert.isTrue(result.isClean)
      assert.strictEqual(yield* Ref.get(calls), 1)
      const notices = (yield* events.recorded).flatMap((event) =>
        event._tag === "Info" ? [event.message] : []
      )
      assert.isTrue(
        notices.some(
          (message) =>
            message.includes("could not determine the changed files") &&
            message.includes("unknown revision")
        ),
        `expected an explanatory notice, saw: ${JSON.stringify(notices)}`
      )
    })
  )

  it.effect("reviews, fixes, and re-reviews until clean", () =>
    Effect.gen(function* () {
      const values = yield* Ref.make<ReadonlyArray<unknown>>([
        {
          issues: [
            {
              severity: "Warning",
              title: "wrong condition",
              description: "Use the boundary value.",
              confidence: 1
            }
          ],
          summary: "one issue"
        },
        { issues: [], summary: "clean" }
      ])
      const calls = yield* Ref.make(0)
      const asks = yield* Ref.make(0)
      const events = yield* makeCollectingFlowEvents
      const coder = yield* makeChat(coderService(asks))
      const result = yield* reviewAndFixLoop({
        reviewers: [lens()],
        reviewerService: reviewerService(values, calls),
        coder,
        taskTitle: "task",
        currentDiff: Effect.succeed("diff"),
        events
      })

      assert.isTrue(result.isClean)
      assert.strictEqual(yield* Ref.get(calls), 2)
      assert.strictEqual(yield* Ref.get(asks), 1)
    })
  )

  it.effect("settle blocking stops at a round whose findings are all non-blocking", () =>
    Effect.gen(function* () {
      const warning = {
        issues: [{ severity: "Warning", title: "naming", description: "", confidence: 1 }],
        summary: "one warning"
      }
      const critical = {
        issues: [{ severity: "Critical", title: "crash", description: "", confidence: 1 }],
        summary: "one critical"
      }
      const run = (settle: "clean" | "blocking", first: unknown) =>
        Effect.gen(function* () {
          const values = yield* Ref.make<ReadonlyArray<unknown>>([first, warning, warning])
          const asks = yield* Ref.make(0)
          const coder = yield* makeChat(coderService(asks))
          const result = yield* reviewAndFixLoop({
            reviewers: [lens()],
            reviewerService: reviewerService(values, yield* Ref.make(0)),
            coder,
            taskTitle: "task",
            currentDiff: Effect.succeed("diff"),
            events: yield* makeCollectingFlowEvents,
            settle
          })
          return { asks: yield* Ref.get(asks), left: result.issues.map((issue) => issue.title) }
        })
      // A Warning alone settles at once; "clean" keeps fixing it.
      assert.deepStrictEqual(yield* run("blocking", warning), { asks: 0, left: ["naming"] })
      assert.deepStrictEqual(yield* run("clean", warning), { asks: 2, left: ["naming"] })
      // A Critical is still fixed, then the Warning it leaves settles.
      assert.deepStrictEqual(yield* run("blocking", critical), { asks: 1, left: ["naming"] })
    })
  )

  it.effect("settle blocking keeps fixing a red gate whatever its severities", () =>
    Effect.gen(function* () {
      const asks = yield* Ref.make(0)
      const coder = yield* makeChat(coderService(asks))
      const gate = ReviewResult.make({
        issues: [ReviewIssue.make({ severity: "Warning", title: "lint warning as error" })]
      })
      const result = yield* reviewAndFixLoop({
        reviewers: [lens()],
        reviewerService: reviewerService(
          yield* Ref.make<ReadonlyArray<unknown>>([]),
          yield* Ref.make(0)
        ),
        coder,
        taskTitle: "task",
        currentDiff: Effect.succeed("diff"),
        events: yield* makeCollectingFlowEvents,
        lint: Effect.succeed(gate),
        maxRounds: 2,
        settle: "blocking"
      })
      assert.isFalse(result.isClean)
      assert.strictEqual(yield* Ref.get(asks), 1)
    })
  )

  it.effect("reuses a lens's answer for an unchanged diff, and reports each round", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      const values = yield* Ref.make<ReadonlyArray<unknown>>([{ issues: [], summary: "clean" }])
      const calls = yield* Ref.make(0)
      const rounds = yield* Ref.make<ReadonlyArray<string>>([])
      const events = yield* makeCollectingFlowEvents
      const coder = yield* makeChat(coderService(yield* Ref.make(0)))
      const once = reviewAndFixLoop({
        reviewers: [lens()],
        reviewerService: reviewerService(values, calls),
        coder,
        taskTitle: "task",
        currentDiff: Effect.succeed("diff"),
        events,
        cache: { files: memory.store, dir: "/state/stories/a.review" },
        onRound: (round, result, settled) =>
          Ref.update(rounds, (all) => [...all, `${round}:${result.isClean}:${settled}`])
      })
      yield* once
      // A rerun on the same diff asks nothing: the lens's answer is on disk.
      yield* once
      assert.strictEqual(yield* Ref.get(calls), 1)
      assert.deepStrictEqual(yield* Ref.get(rounds), ["1:true:true", "1:true:true"])
      const stored = yield* memory.store.read("/state/stories/a.review/correctness.json")
      assert.include(stored ?? "", '"fingerprint"')
    })
  )

  it.effect("short-circuits reviewers when lint is dirty", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const asks = yield* Ref.make(0)
      const events = yield* makeCollectingFlowEvents
      const coder = yield* makeChat(coderService(asks))
      const lint = ReviewResult.make({
        issues: [
          ReviewIssue.make({
            severity: "Critical",
            title: "build failed",
            description: "type error"
          })
        ],
        summary: "lint failed"
      })
      const values = yield* Ref.make<ReadonlyArray<unknown>>([])
      const result = yield* reviewAndFixLoop({
        reviewers: [lens()],
        reviewerService: reviewerService(values, calls),
        coder,
        taskTitle: "task",
        currentDiff: Effect.succeed("diff"),
        events,
        lint: Effect.succeed(lint),
        maxRounds: 1
      })

      assert.isFalse(result.isClean)
      assert.strictEqual(yield* Ref.get(calls), 0)
      assert.strictEqual(yield* Ref.get(asks), 0)
    })
  )

  it.effect("skips file-scoped reviewers that do not match", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const asks = yield* Ref.make(0)
      const events = yield* makeCollectingFlowEvents
      const coder = yield* makeChat(coderService(asks))
      const values = yield* Ref.make<ReadonlyArray<unknown>>([])
      const result = yield* reviewAndFixLoop({
        reviewers: [lens(".*\\.md$")],
        reviewerService: reviewerService(values, calls),
        coder,
        taskTitle: "task",
        currentDiff: Effect.succeed("diff"),
        changedFiles: Effect.succeed(["src/main.ts"]),
        events,
        maxRounds: 1
      })

      assert.isTrue(result.isClean)
      assert.strictEqual(yield* Ref.get(calls), 0)
    })
  )

  it.effect("lets a model select a non-empty subset of matching reviewers", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const values = yield* Ref.make<ReadonlyArray<unknown>>([{ reviewers: ["test"] }])
      const chosen = yield* llmDriven(reviewerService(values, calls)).select(
        [lens(undefined, "correctness"), lens(undefined, "test")],
        ["src/main.ts"],
        1,
        undefined
      )

      assert.deepStrictEqual(
        chosen.map((reviewer) => reviewer.name),
        ["test"]
      )
    })
  )
})

describe("structured-output robustness", () => {
  it.effect("decodes reviewer output that omits confidence, description, and summary", () =>
    Effect.gen(function* () {
      const result = yield* Schema.decodeUnknownEffect(ReviewResult)({
        issues: [{ severity: "Warning", title: "missing fields" }]
      })

      assert.strictEqual(result.issues[0]?.confidence, 1)
      assert.strictEqual(result.issues[0]?.description, "")
      assert.strictEqual(result.summary, "")
    })
  )

  it.effect("retries the reviewer once when its reply fails schema validation", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const asks = yield* Ref.make(0)
      const events = yield* makeCollectingFlowEvents
      const coder = yield* makeChat(coderService(asks))
      const flaky: LlmServiceShape = {
        ...reviewerService(Ref.makeUnsafe<ReadonlyArray<unknown>>([]), Ref.makeUnsafe(0)),
        executeStructuredWithUsage: (_prompt, schema, _jsonSchema) =>
          Ref.updateAndGet(calls, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 1
                ? Effect.fail(ParseError.make({ message: "malformed reviewer reply", raw: "{" }))
                : Schema.decodeUnknownEffect(schema)({ issues: [], summary: "clean" }).pipe(
                    Effect.orDie,
                    Effect.map((value) => [value, undefined, undefined] as const)
                  )
            )
          )
      }
      const result = yield* reviewAndFixLoop({
        reviewers: [lens()],
        reviewerService: flaky,
        coder,
        taskTitle: "task",
        currentDiff: Effect.succeed("diff"),
        events
      })

      assert.isTrue(result.isClean)
      assert.strictEqual(yield* Ref.get(calls), 2)
    })
  )

  it.effect("fails typed when the reviewer reply stays malformed after the retry", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const asks = yield* Ref.make(0)
      const events = yield* makeCollectingFlowEvents
      const coder = yield* makeChat(coderService(asks))
      const broken: LlmServiceShape = {
        ...reviewerService(Ref.makeUnsafe<ReadonlyArray<unknown>>([]), Ref.makeUnsafe(0)),
        executeStructuredWithUsage: (_prompt, _schema, _jsonSchema) =>
          Ref.updateAndGet(calls, (count) => count + 1).pipe(
            Effect.andThen(Effect.fail(ParseError.make({ message: "still malformed", raw: "{" })))
          )
      }
      const error = yield* Effect.flip(
        reviewAndFixLoop({
          reviewers: [lens()],
          reviewerService: broken,
          coder,
          taskTitle: "task",
          currentDiff: Effect.succeed("diff"),
          events
        })
      )

      assert.strictEqual(error._tag, "Llm")
      assert.strictEqual(yield* Ref.get(calls), 2)
    })
  )
})

describe("lintCommand test gate reasons", () => {
  const fixture = (name: string): string =>
    readFileSync(new URL(`./fixtures/gates/${name}`, import.meta.url), "utf8")
  const exitsZeroWith = (output: string) =>
    makeProcessExecutor({
      run: () => Effect.succeed(ProcessResult.make({ stdout: output.split("\n"), exitCode: 0 })),
      runStreaming: () => Stream.empty
    })

  it.effect("a green exit over test files that failed to load is red with a typed reason", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const result = yield* lintCommand(
        exitsZeroWith(fixture("vitest-load-failure.txt")),
        events,
        ["pnpm", "test"],
        "/wt/a"
      )
      assert.isFalse(result.isClean)
      const issue = result.issues[0]
      assert.strictEqual(issue?.gateReason, "load-failure")
      assert.strictEqual(issue?.gateClass, "red")
      assert.strictEqual(issue?.title, "gate failed: pnpm test")
      assert.include(issue?.description ?? "", "test files failed to load (load-failure)")
      assert.include(issue?.description ?? "", "FAIL  test/config.test.ts")
      assert.strictEqual(result.passed, 0)
      const timed = (yield* events.recorded).find((event) => event._tag === "Timed")
      assert.deepStrictEqual(timed?._tag === "Timed" ? [timed.exitCode, timed.failed] : undefined, [
        0,
        true
      ])
    })
  )

  it.effect("a green exit that ran zero tests is red with `zero-tests`", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const result = yield* lintCommand(
        exitsZeroWith(fixture("surefire-no-tests.txt")),
        events,
        ["mvn", "-B", "test"],
        "/wt/a"
      )
      assert.strictEqual(result.issues[0]?.gateReason, "zero-tests")
      assert.include(result.issues[0]?.description ?? "", "No tests to run.")
      assert.strictEqual(result.passed, 0)
    })
  )

  it.effect("a green exit whose tests ran stays green with its count", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const result = yield* lintCommand(
        exitsZeroWith(fixture("vitest-green.txt")),
        events,
        ["pnpm", "test"],
        "/wt/a"
      )
      assert.isTrue(result.isClean)
      assert.strictEqual(result.passed, 1)
    })
  )
})

describe("lintCommand timing", () => {
  it.effect("times a gate command with its exit code, never its output", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const process = makeProcessExecutor({
        run: (argv, _cwd, _env) =>
          Effect.as(
            Effect.sleep("42 seconds"),
            ProcessResult.make({
              stdout: ["FAIL src/a.test.ts secret detail"],
              exitCode: argv[1] === "test" ? 1 : 0
            })
          ),
        runStreaming: () => Stream.empty
      })
      const fiber = yield* Effect.forkChild(lintCommand(process, events, ["pnpm", "test"], "/wt/a"))
      yield* TestClock.adjust("42 seconds")
      const result = yield* Fiber.join(fiber)
      assert.isFalse(result.isClean)
      const timed = (yield* events.recorded).flatMap((event) =>
        event._tag === "Timed" ? [event] : []
      )
      assert.deepStrictEqual(
        timed.map((event) => [event.kind, event.label, event.ms, event.exitCode]),
        [["gate", "pnpm test", 42_000, 1]]
      )
      assert.notInclude(JSON.stringify(timed), "secret")
    })
  )
})

describe("lintCommand spans", () => {
  it.effect("a gate command is a TOOL span with its command and exit code, never its output", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const { tracer, spans } = recordingTracer()
      const process = makeProcessExecutor({
        run: () =>
          Effect.succeed(ProcessResult.make({ stdout: ["FAIL secret detail"], exitCode: 1 })),
        runStreaming: () => Stream.empty
      })
      yield* lintCommand(process, events, ["pnpm", "test"], "/wt/a").pipe(Effect.withTracer(tracer))
      const gate = spans().find((span) => span.attributes[kindAttribute] === "TOOL")
      assert.deepStrictEqual(
        [
          gate?.name,
          gate?.attributes[attr.gateCommand],
          gate?.attributes[attr.gateExit],
          gate?.ended
        ],
        ["gate pnpm test", "pnpm test", 1, true]
      )
      assert.notInclude(JSON.stringify(spans()), "secret")
    })
  )
})

describe("lintCommand timeout and class", () => {
  const neverExits = makeProcessExecutor({
    run: () => Effect.never,
    runStreaming: () => Stream.empty
  })

  it.effect("a gate that never exits ends at the timeout as one Critical of class hang", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const fiber = yield* Effect.forkChild(
        lintCommand(neverExits, events, ["pnpm", "test"], "/wt/a", {
          timeout: Duration.seconds(30)
        })
      )
      yield* TestClock.adjust(Duration.seconds(31))
      const result = yield* Fiber.join(fiber)
      assert.strictEqual(result.issues.length, 1)
      assert.strictEqual(result.issues[0]?.gateClass, "hang")
      assert.include(result.issues[0]?.description ?? "", "no exit after 30 seconds")
      const timed = (yield* events.recorded).find((event) => event._tag === "Timed")
      assert.strictEqual(timed?._tag === "Timed" ? timed.failed : undefined, true)
      assert.isUndefined(timed?._tag === "Timed" ? timed.exitCode : 0)
    })
  )

  it.effect("an exit code of 128 or more is class crash; a smaller non-zero exit is red", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const exits = (code: number) =>
        makeProcessExecutor({
          run: () => Effect.succeed(ProcessResult.make({ stdout: ["boom"], exitCode: code })),
          runStreaming: () => Stream.empty
        })
      const crash = yield* lintCommand(exits(139), events, ["pnpm", "test"], "/wt/a")
      const red = yield* lintCommand(exits(1), events, ["pnpm", "test"], "/wt/a")
      assert.strictEqual(crash.issues[0]?.gateClass, "crash")
      assert.strictEqual(red.issues[0]?.gateClass, "red")
      assert.isUndefined(red.issues[0]?.logPath)
    })
  )

  it.effect("writes the full output to the log when asked and names the path on the issue", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const memory = yield* makeMemoryPlainFileStore()
      const process = makeProcessExecutor({
        run: () =>
          Effect.succeed(ProcessResult.make({ stdout: ["FAIL a"], stderr: ["warn"], exitCode: 1 })),
        runStreaming: () => Stream.empty
      })
      const result = yield* lintCommand(process, events, ["pnpm", "test"], "/wt/a", {
        log: { files: memory.store, path: "/state/stories/a/gates/1-pnpm-test.log" }
      })
      assert.strictEqual(result.issues[0]?.logPath, "/state/stories/a/gates/1-pnpm-test.log")
      assert.strictEqual(
        (yield* memory.files)["/state/stories/a/gates/1-pnpm-test.log"],
        "FAIL a\nwarn"
      )
    })
  )

  it.effect("a green gate with a log sink writes the log too", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const memory = yield* makeMemoryPlainFileStore()
      const process = makeProcessExecutor({
        run: () => Effect.succeed(ProcessResult.make({ stdout: ["ok"], exitCode: 0 })),
        runStreaming: () => Stream.empty
      })
      const result = yield* lintCommand(process, events, ["pnpm", "test"], "/wt/a", {
        log: { files: memory.store, path: "/state/gates/0.log" }
      })
      assert.isTrue(result.isClean)
      assert.strictEqual((yield* memory.files)["/state/gates/0.log"], "ok")
    })
  )
})

describe("fixPrompt evidence", () => {
  const long = Array.from({ length: 200 }, (_, index) => `line ${index}`).join("\n")
  const gate = ReviewResult.make({
    issues: [
      ReviewIssue.make({
        severity: "Critical",
        title: "lint failed: pnpm test",
        description: long,
        logPath: "/state/stories/a/gates/1-pnpm-test.log"
      })
    ],
    summary: "lint failed"
  })

  it("caps the output to the tail and points a CLI coder at the log as its only evidence", () => {
    const prompt = fixPrompt(gate, { tailChars: 100, showPaths: true })
    assert.include(prompt, "line 199")
    assert.notInclude(prompt, "line 0\n")
    assert.include(prompt, "/state/stories/a/gates/1-pnpm-test.log")
    assert.include(prompt, "only runtime evidence")
    assert.include(prompt, "confidence: low")
  })

  it("an API coder gets the tail and no path", () => {
    const prompt = fixPrompt(gate, { tailChars: 100, showPaths: false })
    assert.notInclude(prompt, "/state/stories")
    assert.include(prompt, "only runtime evidence")
  })

  it("a review finding without a gate renders exactly as before", () => {
    const finding = ReviewResult.make({
      issues: [ReviewIssue.make({ severity: "Warning", title: "naming", description: "rename x" })],
      summary: ""
    })
    assert.strictEqual(
      fixPrompt(finding),
      "Address these review findings, then stop:\n- [Warning] naming: rename x"
    )
  })
})

describe("applyTriage", () => {
  const roots = ["/wt/a"]
  const lint = (output: string) =>
    ReviewResult.make({
      issues: [
        ReviewIssue.make({
          severity: "Critical",
          title: "lint failed: pnpm test",
          description: output
        })
      ],
      summary: "lint failed"
    })
  const baseline = GateBaseline.make({
    baseCommit: "abc",
    appDir: ".",
    commands: ["pnpm test"],
    failingLines: ["FAIL old.test.ts > old"],
    recordedAt: 0
  })

  it.effect("inherited failures are published once as Info and do not block", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const reported = yield* Ref.make<ReadonlySet<string>>(new Set())
      const triage = { baseline: Effect.succeed(baseline), roots }
      const first = yield* applyTriage(lint("FAIL old.test.ts > old"), triage, events, reported)
      const second = yield* applyTriage(lint("FAIL old.test.ts > old"), triage, events, reported)
      assert.isTrue(first.isClean)
      assert.isTrue(second.isClean)
      const infos = (yield* events.recorded).filter((event) => event._tag === "Info")
      assert.strictEqual(infos.length, 1)
      assert.include(infos[0]?._tag === "Info" ? infos[0].message : "", "inherited from the base")
    })
  )

  it.effect(
    "a new failure blocks with origin new; a line green on the rerun is flaky and does not",
    () =>
      Effect.gen(function* () {
        const events = yield* makeCollectingFlowEvents
        const reported = yield* Ref.make<ReadonlySet<string>>(new Set())
        const blocked = yield* applyTriage(
          lint("FAIL old.test.ts > old\nFAIL new.test.ts > new"),
          { baseline: Effect.succeed(baseline), roots },
          events,
          reported
        )
        assert.strictEqual(blocked.issues[0]?.origin, "new")
        assert.include(blocked.issues[0]?.description ?? "", "new.test.ts")
        assert.notInclude(blocked.issues[0]?.description ?? "", "old.test.ts")

        const flaky = yield* applyTriage(
          lint("FAIL old.test.ts > old\nFAIL flaky.test.ts > flaky"),
          {
            baseline: Effect.succeed(baseline),
            roots,
            rerunTest: Effect.succeed(lint("FAIL old.test.ts > old"))
          },
          events,
          reported
        )
        assert.isTrue(flaky.isClean)
        const infos = (yield* events.recorded).filter((event) => event._tag === "Info")
        assert.isTrue(
          infos.some((event) => event._tag === "Info" && event.message.includes("flaky"))
        )
      })
  )

  it.effect("a rerun that stays red keeps the new failure charged", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const reported = yield* Ref.make<ReadonlySet<string>>(new Set())
      const result = yield* applyTriage(
        lint("FAIL new.test.ts > new"),
        {
          baseline: Effect.succeed(baseline),
          roots,
          rerunTest: Effect.succeed(lint("FAIL new.test.ts > new"))
        },
        events,
        reported
      )
      assert.isFalse(result.isClean)
    })
  )

  it.effect(
    "without triage options, or without a stored baseline, the result is returned untouched",
    () =>
      Effect.gen(function* () {
        const events = yield* makeCollectingFlowEvents
        const reported = yield* Ref.make<ReadonlySet<string>>(new Set())
        const result = lint("FAIL old.test.ts > old")
        assert.strictEqual(yield* applyTriage(result, undefined, events, reported), result)
        assert.strictEqual(
          yield* applyTriage(
            result,
            { baseline: Effect.succeed(undefined), roots },
            events,
            reported
          ),
          result
        )
      })
  )
})

describe("oracle guard in the review loop (ADR 0027)", () => {
  const skipDiff = [
    "diff --git a/src/a.test.ts b/src/a.test.ts",
    "--- a/src/a.test.ts",
    "+++ b/src/a.test.ts",
    "@@ -1,2 +1,2 @@",
    "-it('a', () => {})",
    "+it.skip('a', () => {})",
    " export {}"
  ].join("\n")

  it.effect(
    "an added skip marker fails the round and is handed to the coder; declared, it passes",
    () =>
      Effect.gen(function* () {
        const events = yield* makeCollectingFlowEvents
        const values = yield* Ref.make<ReadonlyArray<unknown>>([])
        const calls = yield* Ref.make(0)
        const asks = yield* Ref.make(0)
        const coder = yield* makeChat(coderService(asks))
        const result = yield* reviewAndFixLoop({
          reviewers: [],
          reviewerService: reviewerService(values, calls),
          coder,
          taskTitle: "t",
          currentDiff: Effect.succeed(skipDiff),
          events,
          maxRounds: 1,
          oracle: { diff: Effect.succeed(skipDiff) }
        })
        assert.isFalse(result.isClean)
        assert.include(result.issues[0]?.title ?? "", "oracle: skip or focus marker")
        const declared = yield* reviewAndFixLoop({
          reviewers: [],
          reviewerService: reviewerService(values, calls),
          coder,
          taskTitle: "t",
          currentDiff: Effect.succeed(skipDiff),
          events,
          maxRounds: 1,
          oracle: { diff: Effect.succeed(skipDiff), declared: true }
        })
        assert.isTrue(declared.isClean)
      })
  )

  it.effect(
    "a passed-count drop against the base is a Critical; unknown counts are noted once",
    () =>
      Effect.gen(function* () {
        const events = yield* makeCollectingFlowEvents
        const values = yield* Ref.make<ReadonlyArray<unknown>>([])
        const calls = yield* Ref.make(0)
        const asks = yield* Ref.make(0)
        const coder = yield* makeChat(coderService(asks))
        const green = Effect.succeed(
          ReviewResult.make({ issues: [], summary: "lint passed", passed: 10 })
        )
        const dropped = yield* reviewAndFixLoop({
          reviewers: [],
          reviewerService: reviewerService(values, calls),
          coder,
          taskTitle: "t",
          currentDiff: Effect.succeed(""),
          events,
          maxRounds: 1,
          lint: green,
          oracle: { diff: Effect.succeed(""), baseCount: Effect.succeed(12) }
        })
        assert.include(dropped.issues[0]?.title ?? "", "fewer tests pass")
        const unknown = yield* reviewAndFixLoop({
          reviewers: [],
          reviewerService: reviewerService(values, calls),
          coder,
          taskTitle: "t",
          currentDiff: Effect.succeed(""),
          events,
          maxRounds: 2,
          lint: green,
          oracle: { diff: Effect.succeed(""), baseCount: Effect.succeed(undefined) }
        })
        assert.isTrue(unknown.isClean)
        const notes = (yield* events.recorded).filter(
          (event) => event._tag === "Info" && event.message.includes("count comparison skipped")
        )
        assert.strictEqual(notes.length, 1)
      })
  )
})

describe("adversarial review (ADR 0027)", () => {
  const issue = (
    severity: "Critical" | "Warning" | "Info",
    title: string,
    file?: string,
    line?: number
  ): ReviewIssue =>
    ReviewIssue.make({
      severity,
      title,
      description: "",
      ...(file === undefined ? {} : { file }),
      ...(line === undefined ? {} : { line })
    })

  it("the adversarial lens is in the minimal set and every lens carries the preamble unless it opts out", () => {
    assert.isTrue(minimalReviewers.some((lens) => lens.name === adversarialReviewer.name))
    assert.include(lensPrompt(adversarialReviewer), reviewRulesPreamble)
    assert.include(lensPrompt(adversarialReviewer), "Assume the code is wrong")
    const quiet = Reviewer.make({ name: "quiet", systemPrompt: "Own rules.", preamble: false })
    assert.strictEqual(lensPrompt(quiet), "Own rules.")
  })

  it("mergeVotes: any Critical blocks, Warnings are one per place, an Info needs two votes", () => {
    const merged = mergeVotes([
      ReviewResult.make({
        issues: [
          issue("Critical", "boom", "src/a.ts", 3),
          issue("Warning", "naming", "src/a.ts", 9),
          issue("Info", "style", "src/a.ts", 20)
        ],
        summary: "one"
      }),
      ReviewResult.make({
        issues: [
          issue("Warning", "other words", "src/a.ts", 9),
          issue("Warning", "elsewhere", "src/b.ts", 1),
          issue("Info", "nit")
        ],
        summary: "two"
      })
    ])
    assert.deepStrictEqual(
      merged.issues.map((entry) => [entry.severity, entry.title]),
      [
        ["Critical", "boom"],
        ["Warning", "naming"],
        ["Warning", "elsewhere"]
      ]
    )
    assert.strictEqual(merged.summary, "one | two")
    const single = ReviewResult.make({ issues: [issue("Info", "nit")], summary: "" })
    assert.strictEqual(mergeVotes([single]), single)
  })

  it.effect(
    "demoteUnplaced: a Critical without a file becomes a Warning, an off-diff finding an Info, each published",
    () =>
      Effect.gen(function* () {
        const events = yield* makeCollectingFlowEvents
        const placed = yield* demoteUnplaced(
          lens(),
          ReviewResult.make({
            issues: [
              issue("Critical", "no file"),
              issue("Critical", "wrong file", "src/other.ts", 1),
              issue("Critical", "right", "src/a.ts", 2)
            ],
            summary: ""
          }),
          ["src/a.ts"],
          events
        )
        assert.deepStrictEqual(
          placed.issues.map((entry) => [entry.severity, entry.title]),
          [
            ["Warning", "no file"],
            ["Info", "wrong file"],
            ["Critical", "right"]
          ]
        )
        const demoted = (yield* events.recorded).filter(
          (event) => event._tag === "ReviewFindingDemoted"
        )
        assert.strictEqual(demoted.length, 2)
        const untouched = yield* demoteUnplaced(lens(), placed, [], events)
        assert.strictEqual(untouched, placed)
      })
  )

  it.effect(
    "votes run the adversarial lens several times and merge; the fix goes through fixWith when given",
    () =>
      Effect.gen(function* () {
        const events = yield* makeCollectingFlowEvents
        const values = yield* Ref.make<ReadonlyArray<unknown>>([
          {
            issues: [
              { severity: "Critical", title: "vote one", description: "", file: "f", line: 1 }
            ],
            summary: "a"
          },
          {
            issues: [
              { severity: "Warning", title: "vote two", description: "", file: "f", line: 2 }
            ],
            summary: "b"
          },
          { issues: [], summary: "clean" },
          { issues: [], summary: "clean" }
        ])
        const calls = yield* Ref.make(0)
        const asks = yield* Ref.make(0)
        const fixes: Array<string> = []
        const coder = yield* makeChat(coderService(asks))
        const result = yield* reviewAndFixLoop({
          reviewers: [adversarialReviewer],
          reviewerService: reviewerService(values, calls),
          coder,
          taskTitle: "t",
          currentDiff: Effect.succeed("diff --git a/f b/f\n+x"),
          changedFiles: Effect.succeed(["f"]),
          events,
          maxRounds: 2,
          votes: 2,
          fixWith: (prompt) =>
            Effect.sync(() => {
              fixes.push(prompt)
              return "fixed"
            })
        })
        assert.isTrue(result.isClean)
        assert.strictEqual(yield* Ref.get(calls), 4)
        assert.strictEqual(fixes.length, 1)
        assert.include(fixes[0] ?? "", "vote one")
        assert.include(fixes[0] ?? "", "vote two")
        assert.strictEqual(yield* Ref.get(asks), 0)
      })
  )

  it.effect(
    "the repository's review rules file loads as one lens; absent or empty means none",
    () =>
      Effect.gen(function* () {
        const memory = yield* makeMemoryPlainFileStore({
          "/repo/.llm4ts/review-rules.md": "---\nfiles: src/.*\n---\nNever log a token."
        })
        const rules = yield* loadRepoReviewRules(memory.store, "/repo")
        assert.strictEqual(rules?.name, "repo-rules")
        assert.strictEqual(rules?.systemPrompt, "Never log a token.")
        assert.strictEqual(rules?.files, "src/.*")
        const none = yield* makeMemoryPlainFileStore({ "/repo/.llm4ts/review-rules.md": "  \n" })
        assert.isUndefined(yield* loadRepoReviewRules(none.store, "/repo"))
        assert.isUndefined(yield* loadRepoReviewRules(memory.store, "/elsewhere"))
      })
  )
})

describe("stall on an identical diff (ADR 0027)", () => {
  it.effect(
    "a fix round that leaves the diff unchanged ends the task as Stalled when asked; silently loops otherwise",
    () =>
      Effect.gen(function* () {
        const finding = {
          issues: [
            { severity: "Warning", title: "wrong condition", description: "", confidence: 1 }
          ],
          summary: "one"
        }
        const values = yield* Ref.make<ReadonlyArray<unknown>>([finding, finding, finding])
        const calls = yield* Ref.make(0)
        const asks = yield* Ref.make(0)
        const events = yield* makeCollectingFlowEvents
        const coder = yield* makeChat(coderService(asks))
        const error = yield* Effect.flip(
          reviewAndFixLoop({
            reviewers: [lens()],
            reviewerService: reviewerService(values, calls),
            coder,
            taskTitle: "task",
            currentDiff: Effect.succeed("diff"),
            events,
            maxRounds: 3,
            stallOnIdenticalDiff: true
          })
        )
        assert.strictEqual(error._tag, "Stalled")
        assert.match(error.message, /identical-diff/)
        assert.strictEqual(yield* Ref.get(asks), 1)

        yield* Ref.set(values, [finding, finding, finding])
        const settled = yield* reviewAndFixLoop({
          reviewers: [lens()],
          reviewerService: reviewerService(values, calls),
          coder,
          taskTitle: "task",
          currentDiff: Effect.succeed("diff"),
          events,
          maxRounds: 2
        })
        assert.isFalse(settled.isClean)
      })
  )
})

describe("review rounds say what runs", () => {
  it.effect("names each lens call's purpose and frames the round in one line", () =>
    Effect.gen(function* () {
      const purposes = yield* Ref.make<ReadonlyArray<string>>([])
      const service: LlmServiceShape = {
        ...reviewerService(yield* Ref.make<ReadonlyArray<unknown>>([]), yield* Ref.make(0)),
        executeStructuredWithUsage: <A, E, RD, RE>(
          _prompt: string,
          schema: Schema.ConstraintCodec<A, E, RD, RE>
        ) =>
          Effect.gen(function* () {
            const purpose = yield* callPurpose
            yield* Ref.update(purposes, (all) => [...all, purpose ?? "(none)"])
            const value = yield* Schema.decodeUnknownEffect(schema)({ issues: [] }).pipe(
              Effect.orDie
            )
            return [value, undefined, undefined] as const
          })
      }
      const events = yield* makeCollectingFlowEvents
      yield* reviewAndFixLoop({
        reviewers: minimalReviewers,
        reviewerService: service,
        coder: yield* makeChat(coderService(yield* Ref.make(0))),
        taskTitle: "add the page",
        currentDiff: Effect.succeed("diff"),
        events,
        votes: 2
      })
      assert.sameMembers(
        [...(yield* Ref.get(purposes))],
        [
          "adversarial lens · vote 1 of 2",
          "adversarial lens · vote 2 of 2",
          ...minimalReviewers.slice(1).map((lens) => `${lens.name} lens`)
        ]
      )
      const framed = (yield* events.recorded).flatMap((event) =>
        event._tag === "Info" && event.message.startsWith("review round") ? [event.message] : []
      )
      assert.deepStrictEqual(framed, [
        `review round 1 of "add the page": 4 lenses in parallel (adversarial ×2, ${minimalReviewers
          .slice(1)
          .map((lens) => lens.name)
          .join(", ")})`
      ])
    })
  )
})

describe("lens attribution (ADR 0044)", () => {
  it("tagLens names the lens on untagged issues only", () => {
    const result = ReviewResult.make({
      issues: [
        ReviewIssue.make({ severity: "Warning", title: "a" }),
        ReviewIssue.make({ severity: "Warning", title: "b", lens: "judge" })
      ]
    })
    assert.deepStrictEqual(
      tagLens("correctness", result).issues.map((issue) => issue.lens),
      ["correctness", "judge"]
    )
  })

  it.effect("a ReviewIssue without lens still decodes", () =>
    Effect.gen(function* () {
      const issue = yield* Schema.decodeUnknownEffect(ReviewIssue)({
        severity: "Info",
        title: "x"
      })
      assert.isUndefined(issue.lens)
    })
  )

  it.effect("reviewAndFixLoop tags each lens's findings with its name", () =>
    Effect.gen(function* () {
      const finding = (title: string) => ({
        issues: [{ severity: "Warning", title }],
        summary: ""
      })
      const values = yield* Ref.make<ReadonlyArray<unknown>>([finding("one"), finding("two")])
      const coder = yield* makeChat(coderService(yield* Ref.make(0)))
      const result = yield* reviewAndFixLoop({
        reviewers: [lens(), lens(undefined, "security")],
        reviewerService: reviewerService(values, yield* Ref.make(0)),
        coder,
        taskTitle: "task",
        currentDiff: Effect.succeed("diff"),
        events: yield* makeCollectingFlowEvents,
        parallelism: 1,
        maxRounds: 1
      })
      assert.deepStrictEqual(
        result.issues.map((issue) => [issue.title, issue.lens]),
        [
          ["one", "correctness"],
          ["two", "security"]
        ]
      )
    })
  )
})

describe("reviewAndFixLoop recheck mode (ADR 0044)", () => {
  const section = (path: string, line: string): string =>
    [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      "@@ -1,1 +1,1 @@",
      `+${line}`
    ].join("\n")

  const tagged = (name: string, files?: string): Reviewer =>
    Reviewer.make({
      name,
      systemPrompt: `LENS:${name}`,
      ...(files === undefined ? {} : { files })
    })

  const answer = (...titles: ReadonlyArray<string>) => ({
    issues: titles.map((title) => ({ severity: "Warning", title })),
    summary: ""
  })

  /** Answers each lens from its own queue (clean when empty) and records every prompt. */
  const lensService = (
    answers: Readonly<Record<string, ReadonlyArray<unknown>>>,
    prompts: Ref.Ref<ReadonlyArray<string>>
  ): LlmServiceShape => {
    const queues = new Map(Object.entries(answers).map(([name, list]) => [name, [...list]]))
    const next = <A, E, RD, RE>(prompt: string, schema: Schema.ConstraintCodec<A, E, RD, RE>) =>
      Ref.update(prompts, (all) => [...all, prompt]).pipe(
        Effect.andThen(
          Effect.sync(() => {
            const name = /LENS:(\w+)/u.exec(prompt)?.[1] ?? ""
            return queues.get(name)?.shift() ?? { issues: [], summary: "clean" }
          })
        ),
        Effect.flatMap((value) => Schema.decodeUnknownEffect(schema)(value).pipe(Effect.orDie))
      )
    return {
      ...reviewerService(Ref.makeUnsafe<ReadonlyArray<unknown>>([]), Ref.makeUnsafe(0)),
      executeStructured: (prompt, schema, _jsonSchema) => next(prompt, schema),
      executeStructuredWithUsage: (prompt, schema, _jsonSchema) =>
        next(prompt, schema).pipe(Effect.map((value) => [value, undefined, undefined] as const))
    }
  }

  /** The diff before any fix, then after each fix the coder applies. */
  const diffs = (asks: Ref.Ref<number>, versions: ReadonlyArray<string>) =>
    Effect.map(Ref.get(asks), (count) => versions[Math.min(count, versions.length - 1)] ?? "")

  it.effect(
    "round 2 reruns only the lens with findings, with its earlier findings in the prompt",
    () =>
      Effect.gen(function* () {
        const prompts = yield* Ref.make<ReadonlyArray<string>>([])
        const asks = yield* Ref.make(0)
        const result = yield* reviewAndFixLoop({
          reviewers: [tagged("a"), tagged("b")],
          reviewerService: lensService({ a: [answer("bug")] }, prompts),
          coder: yield* makeChat(coderService(asks)),
          taskTitle: "story s1",
          currentDiff: diffs(asks, [section("x.ts", "one"), section("x.ts", "two")]),
          events: yield* makeCollectingFlowEvents,
          parallelism: 1,
          recheck: {}
        })
        assert.isTrue(result.isClean)
        const seen = yield* Ref.get(prompts)
        assert.strictEqual(seen.length, 3)
        const last = seen[2] ?? ""
        assert.include(last, "LENS:a")
        assert.include(last, "re-check")
        assert.include(last, "bug")
      })
  )

  it.effect("a clean lens reruns when the fix touches a file it never saw", () =>
    Effect.gen(function* () {
      const prompts = yield* Ref.make<ReadonlyArray<string>>([])
      const asks = yield* Ref.make(0)
      yield* reviewAndFixLoop({
        reviewers: [tagged("a"), tagged("b", "\\.test\\.ts$")],
        reviewerService: lensService({ a: [answer("bug")] }, prompts),
        coder: yield* makeChat(coderService(asks)),
        taskTitle: "story s1",
        currentDiff: diffs(asks, [
          [section("x.ts", "one"), section("y.test.ts", "t")].join("\n"),
          [section("x.ts", "two"), section("y.test.ts", "t"), section("z.test.ts", "n")].join("\n")
        ]),
        events: yield* makeCollectingFlowEvents,
        parallelism: 1,
        recheck: {}
      })
      const round2 = (yield* Ref.get(prompts)).slice(2)
      assert.strictEqual(round2.length, 2)
      assert.isTrue(
        round2.some((prompt) => prompt.includes("LENS:a") && prompt.includes("re-check"))
      )
      assert.isTrue(
        round2.some((prompt) => prompt.includes("LENS:b") && !prompt.includes("re-check"))
      )
    })
  )

  it.effect("the result is the standing findings across rounds", () =>
    Effect.gen(function* () {
      const prompts = yield* Ref.make<ReadonlyArray<string>>([])
      const asks = yield* Ref.make(0)
      const result = yield* reviewAndFixLoop({
        reviewers: [tagged("a"), tagged("b")],
        reviewerService: lensService(
          { a: [answer("bug"), answer()], b: [answer("slow"), answer("slow")] },
          prompts
        ),
        coder: yield* makeChat(coderService(asks)),
        taskTitle: "story s1",
        currentDiff: diffs(asks, [section("x.ts", "one"), section("x.ts", "two")]),
        events: yield* makeCollectingFlowEvents,
        parallelism: 1,
        maxRounds: 2,
        recheck: {}
      })
      assert.deepStrictEqual(
        result.issues.map((issue) => [issue.title, issue.lens]),
        [["slow", "b"]]
      )
    })
  )

  it.effect("an extra review runs beside the lenses and gets its prior on re-check", () =>
    Effect.gen(function* () {
      const prompts = yield* Ref.make<ReadonlyArray<string>>([])
      const asks = yield* Ref.make(0)
      const priors = yield* Ref.make<ReadonlyArray<ReadonlyArray<string> | undefined>>([])
      const verdicts = [
        ReviewResult.make({
          issues: [ReviewIssue.make({ severity: "Critical", title: "missing" })]
        }),
        ReviewResult.make({ issues: [] })
      ]
      const result = yield* reviewAndFixLoop({
        reviewers: [tagged("a")],
        reviewerService: lensService({}, prompts),
        coder: yield* makeChat(coderService(asks)),
        taskTitle: "story s1",
        currentDiff: diffs(asks, [section("x.ts", "one"), section("x.ts", "two")]),
        events: yield* makeCollectingFlowEvents,
        recheck: {
          extra: [
            {
              name: "judge",
              review: (_diff, prior) =>
                Ref.modify(priors, (all) => [
                  verdicts[all.length] ?? ReviewResult.make({ issues: [] }),
                  [...all, prior?.map((issue) => issue.title)]
                ])
            }
          ]
        }
      })
      assert.isTrue(result.isClean)
      assert.deepStrictEqual(yield* Ref.get(priors), [undefined, ["missing"]])
      // The clean lens is not asked again.
      assert.strictEqual((yield* Ref.get(prompts)).length, 1)
    })
  )

  it.effect("a red gate round runs no reviewer and a lens that never ran reviews in full", () =>
    Effect.gen(function* () {
      const prompts = yield* Ref.make<ReadonlyArray<string>>([])
      const asks = yield* Ref.make(0)
      const gates = yield* Ref.make<ReadonlyArray<ReviewResult>>([
        ReviewResult.make({
          issues: [ReviewIssue.make({ severity: "Critical", title: "gate failed: tsc" })]
        })
      ])
      const result = yield* reviewAndFixLoop({
        reviewers: [tagged("a")],
        reviewerService: lensService({}, prompts),
        coder: yield* makeChat(coderService(asks)),
        taskTitle: "story s1",
        currentDiff: diffs(asks, [section("x.ts", "one"), section("x.ts", "two")]),
        events: yield* makeCollectingFlowEvents,
        lint: Ref.modify(gates, (queue) => [
          queue[0] ?? ReviewResult.make({ issues: [] }),
          queue.slice(1)
        ]),
        recheck: {}
      })
      assert.isTrue(result.isClean)
      const seen = yield* Ref.get(prompts)
      assert.strictEqual(seen.length, 1)
      assert.notInclude(seen[0] ?? "", "re-check")
    })
  )

  it.effect("resumes from saved memory at the next round", () =>
    Effect.gen(function* () {
      const prompts = yield* Ref.make<ReadonlyArray<string>>([])
      const saved = yield* Ref.make<ReadonlyArray<ReviewMemory>>([])
      const events = yield* makeCollectingFlowEvents
      const before = remember(
        undefined,
        1,
        diffChunks(section("x.ts", "one")),
        [
          {
            name: "a",
            result: tagLens(
              "a",
              ReviewResult.make({
                issues: [ReviewIssue.make({ severity: "Warning", title: "bug" })]
              })
            )
          },
          { name: "b", result: ReviewResult.make({ issues: [] }) }
        ],
        ["x.ts"]
      )
      const result = yield* reviewAndFixLoop({
        reviewers: [tagged("a"), tagged("b")],
        reviewerService: lensService({}, prompts),
        coder: yield* makeChat(coderService(yield* Ref.make(0))),
        taskTitle: "story s1",
        currentDiff: Effect.succeed(section("x.ts", "two")),
        events,
        recheck: {
          memory: {
            load: Effect.succeed(before),
            save: (memory) => Ref.update(saved, (all) => [...all, memory])
          }
        }
      })
      assert.isTrue(result.isClean)
      const seen = yield* Ref.get(prompts)
      assert.strictEqual(seen.length, 1)
      assert.include(seen[0] ?? "", "re-check")
      // The saved round's fix had not landed: it is applied (and recorded) first.
      assert.deepStrictEqual(
        (yield* Ref.get(saved)).map((memory) => [memory.round, memory.fixed === true]),
        [
          [1, true],
          [2, false]
        ]
      )
      const rounds = (yield* events.recorded).flatMap((event) =>
        event._tag === "ReviewFindings" ? [event.round] : []
      )
      assert.deepStrictEqual(rounds, [2])
    })
  )

  it.effect("a resume whose fix never landed applies it before reviewing", () =>
    Effect.gen(function* () {
      for (const fixed of [false, true]) {
        const prompts = yield* Ref.make<ReadonlyArray<string>>([])
        const asks = yield* Ref.make(0)
        const asksAtReview = yield* Ref.make<ReadonlyArray<number>>([])
        const saved = yield* Ref.make<ReadonlyArray<ReviewMemory>>([])
        const remembered = remember(
          undefined,
          1,
          diffChunks(section("x.ts", "one")),
          [
            {
              name: "a",
              result: tagLens(
                "a",
                ReviewResult.make({
                  issues: [ReviewIssue.make({ severity: "Warning", title: "bug" })]
                })
              )
            }
          ],
          ["x.ts"]
        )
        const before = fixed ? ReviewMemory.make({ ...remembered, fixed: true }) : remembered
        const seat = lensService({}, prompts)
        const watched: LlmServiceShape = {
          ...seat,
          executeStructuredWithUsage: (prompt, schema, jsonSchema) =>
            Effect.andThen(
              Effect.flatMap(Ref.get(asks), (count) =>
                Ref.update(asksAtReview, (all) => [...all, count])
              ),
              seat.executeStructuredWithUsage(prompt, schema, jsonSchema)
            )
        }
        yield* reviewAndFixLoop({
          reviewers: [tagged("a")],
          reviewerService: watched,
          coder: yield* makeChat(coderService(asks)),
          taskTitle: "story s1",
          currentDiff: diffs(asks, [section("x.ts", "one"), section("x.ts", "two")]),
          events: yield* makeCollectingFlowEvents,
          recheck: {
            memory: {
              load: Effect.succeed(before),
              save: (memory) => Ref.update(saved, (all) => [...all, memory])
            }
          }
        })
        assert.deepStrictEqual(yield* Ref.get(asksAtReview), [fixed ? 0 : 1])
        if (!fixed) {
          assert.isTrue((yield* Ref.get(saved)).some((memory) => memory.fixed === true))
        }
      }
    })
  )

  it.effect("without recheck every lens runs every round, as before", () =>
    Effect.gen(function* () {
      const prompts = yield* Ref.make<ReadonlyArray<string>>([])
      const asks = yield* Ref.make(0)
      yield* reviewAndFixLoop({
        reviewers: [tagged("a"), tagged("b")],
        reviewerService: lensService({ a: [answer("bug")] }, prompts),
        coder: yield* makeChat(coderService(asks)),
        taskTitle: "task",
        currentDiff: diffs(asks, [section("x.ts", "one"), section("x.ts", "two")]),
        events: yield* makeCollectingFlowEvents,
        parallelism: 1
      })
      const seen = yield* Ref.get(prompts)
      assert.strictEqual(seen.length, 4)
      assert.isFalse(seen.some((prompt) => prompt.includes("re-check")))
    })
  )
})

describe("review diff size (ADR 0044)", () => {
  it.effect("ReviewFindings carry the reviewed diff's line count", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      yield* reviewAndFixLoop({
        reviewers: [lens()],
        reviewerService: reviewerService(
          yield* Ref.make<ReadonlyArray<unknown>>([]),
          yield* Ref.make(0)
        ),
        coder: yield* makeChat(coderService(yield* Ref.make(0))),
        taskTitle: "task",
        currentDiff: Effect.succeed("line one\nline two\nline three"),
        events
      })
      const sizes = (yield* events.recorded).flatMap((event) =>
        event._tag === "ReviewFindings" ? [event.diffLines] : []
      )
      assert.deepStrictEqual(sizes, [3])
    })
  )
})
