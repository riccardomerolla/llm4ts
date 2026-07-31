import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { InvalidRequestError, ParseError } from "@llm4ts/core/Errors"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import { LlmChunk, TokenUsage } from "@llm4ts/core/Models"
import { makeChat } from "@llm4ts/flow/Chat"
import { makeCollectingFlowEvents } from "@llm4ts/flow/FlowEvents"
import { Reviewer } from "@llm4ts/flow/Pack"
import { ReviewIssue, ReviewResult, llmDriven, reviewAndFixLoop } from "@llm4ts/flow/Review"

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
  // Reviewer lenses are structured calls, and their usage went unpublished:
  // every flow whose cost is dominated by review reported none of it.
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
