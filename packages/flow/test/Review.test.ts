import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { InvalidRequestError, ParseError } from "@llm4ts/core/Errors"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import { LlmChunk, TokenUsage } from "@llm4ts/core/Models"
import { makeChat } from "@llm4ts/flow/Chat"
import { ProcessError } from "@llm4ts/flow/FlowError"
import { makeCollectingFlowEvents, ReviewFinding } from "@llm4ts/flow/FlowEvents"
import { Reviewer } from "@llm4ts/flow/Pack"
import { ReviewIssue, ReviewResult, llmDriven, reviewAndFixLoop } from "@llm4ts/flow/Review"
import { unsupportedScoreLabels } from "@llm4ts/core/LabelScoring"
import { makeFakeJudgment } from "@llm4ts/core/judgment/FakeJudgment"
import { JudgmentBackendError } from "@llm4ts/core/judgment/Judgment"
import { origins, truthAnswer } from "@llm4ts/core/judgment/Schemas"
import type { JudgmentMode } from "@llm4ts/flow/Judgment"

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
          assert.deepStrictEqual(result.issues, dirty.issues)
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
