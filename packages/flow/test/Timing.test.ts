import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { TestClock } from "effect/testing"
import { InvalidRequestError } from "@llm4ts/core/Errors"
import { unsupportedScoreLabels } from "@llm4ts/core/LabelScoring"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import { LlmChunk, Message, TokenUsage } from "@llm4ts/core/Models"
import { collect } from "@llm4ts/core/Streaming"
import { makeCollectingFlowEvents, type FlowEvent } from "@llm4ts/flow/FlowEvents"
import { timedJudgment, timedSeat, withTimedRole } from "@llm4ts/flow/Timing"
import { makeFakeJudgment } from "@llm4ts/core/judgment/FakeJudgment"
import { makeFlowEventHub } from "@llm4ts/flow/FlowEvents"
import { attr, kindAttribute } from "@llm4ts/flow/Spans"
import { recordingTracer } from "./support/RecordingTracer.ts"

const unused = InvalidRequestError.make({ message: "unused" })

const chunk = (delta: string, metadata: Record<string, string> = {}) =>
  LlmChunk.make({ delta, metadata })

const serviceOf = (overrides: Partial<LlmServiceShape>): LlmServiceShape => ({
  executeStream: (_prompt) => Stream.empty,
  executeStreamWithHistory: (_messages) => Stream.empty,
  executeWithTools: (_prompt, _tools) => Effect.fail(unused),
  executeStructured: (_prompt, _schema, _jsonSchema) => Effect.fail(unused),
  executeStructuredWithUsage: (_prompt, _schema, _jsonSchema) => Effect.fail(unused),
  scoreLabels: unsupportedScoreLabels,
  isAvailable: Effect.succeed(true),
  ...overrides
})

const timings = (recorded: ReadonlyArray<FlowEvent>) =>
  recorded.flatMap((event) => (event._tag === "Timed" ? [event] : []))

describe("timedSeat", () => {
  it.effect("times a streamed call from its start to its end, and to its first output", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const slow = serviceOf({
        executeStream: (_prompt) =>
          Stream.fromEffect(Effect.as(Effect.sleep("3 seconds"), chunk("Hel"))).pipe(
            Stream.concat(
              Stream.fromEffect(
                Effect.as(
                  Effect.sleep("7 seconds"),
                  chunk("lo", { api_ms: "6000", tools_ms: "2500" })
                )
              )
            )
          )
      })
      const seat = timedSeat(slow, events, "coder")
      const fiber = yield* Effect.forkChild(collect(seat.executeStream("hi")))
      yield* TestClock.adjust("10 seconds")
      const reply = yield* Fiber.join(fiber)
      assert.strictEqual(reply.content, "Hello")
      const [timed] = timings(yield* events.recorded)
      assert.deepStrictEqual(
        [timed?.kind, timed?.label, timed?.ms, timed?.firstMs, timed?.apiMs, timed?.toolMs],
        ["model", "coder", 10_000, 3_000, 6_000, 2_500]
      )
    })
  )

  it.effect("times a call that fails too, and every non-streaming method", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const seat = timedSeat(
        serviceOf({
          executeStructured: (_prompt, _schema, _jsonSchema) =>
            Effect.andThen(Effect.sleep("4 seconds"), Effect.fail(unused))
        }),
        events,
        "reviewer"
      )
      const fiber = yield* Effect.forkChild(
        Effect.flip(seat.executeStructured("judge", Schema.String, {}))
      )
      yield* TestClock.adjust("4 seconds")
      assert.strictEqual((yield* Fiber.join(fiber))._tag, "InvalidRequestError")
      const [timed] = timings(yield* events.recorded)
      assert.deepStrictEqual([timed?.label, timed?.ms, timed?.failed], ["reviewer", 4_000, true])
    })
  )

  it.effect("names a call by the role it is made for, when the caller says", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const seat = timedSeat(
        serviceOf({ executeStream: () => Stream.make(chunk("ok")) }),
        events,
        "reasoning"
      )
      yield* collect(seat.executeStream("plain"))
      yield* withTimedRole("judge", collect(seat.executeStream("verdict")))
      assert.deepStrictEqual(
        timings(yield* events.recorded).map((timed) => timed.label),
        ["reasoning", "judge"]
      )
    })
  )

  it.effect("times a typed judgment as a judgment call", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const judgment = timedJudgment((yield* makeFakeJudgment({})).judgment, events)
      yield* Effect.exit(judgment.judge({ state: "s", questions: {} }))
      assert.deepStrictEqual(
        timings(yield* events.recorded).map((timed) => [timed.kind, timed.label]),
        [["model", "judgment"]]
      )
    })
  )
})

describe("timedSeat spans", () => {
  const chunks = (...parts: ReadonlyArray<LlmChunk>) => Stream.fromIterable(parts)
  const toolUse = LlmChunk.make({
    delta: "",
    metadata: {
      event: "tool_use",
      tool_name: "grep",
      tool_id: "t1",
      tool_input: '{"pattern":"secret"}'
    }
  })
  const toolResult = LlmChunk.make({
    delta: "",
    metadata: { event: "tool_result", tool_id: "t1", tool_content: "src/a.ts: const secret = 1" }
  })
  const reply = LlmChunk.make({
    delta: "done",
    finishReason: "stop",
    usage: TokenUsage.make({ prompt: 10, completion: 5, total: 15 }),
    metadata: { model: "gemini-2.5-pro" }
  })
  const streaming = serviceOf({
    executeStreamWithHistory: () => chunks(toolUse, toolResult, reply)
  })
  const user = Message.make({ role: "User", content: "do it" })
  const system = Message.make({ role: "System", content: "rules" })

  it.effect(
    "an LLM span per call with GenAI usage, a TOOL child per tool call, no content by default",
    () =>
      Effect.gen(function* () {
        const events = yield* makeFlowEventHub()
        const { tracer, spans } = recordingTracer()
        const seat = timedSeat(streaming, events, "coder", { executor: Effect.succeed("gemini") })
        yield* collect(seat.executeStreamWithHistory([user])).pipe(Effect.withTracer(tracer))
        const llm = spans().find((span) => span.attributes[kindAttribute] === "LLM")
        assert.strictEqual(llm?.name, "coder")
        assert.strictEqual(llm?.kind, "client")
        assert.deepStrictEqual(
          [
            llm?.attributes[attr.role],
            llm?.attributes[attr.executor],
            llm?.attributes[attr.model],
            llm?.attributes[attr.inputTokens],
            llm?.attributes[attr.outputTokens],
            llm?.attributes[attr.estimated]
          ],
          ["coder", "gemini", "gemini-2.5-pro", 10, 5, false]
        )
        assert.isTrue(llm?.ended)
        const tool = spans().find((span) => span.attributes[kindAttribute] === "TOOL")
        assert.deepStrictEqual(
          [tool?.name, tool?.parentName, tool?.attributes[attr.toolCategory], tool?.ended],
          ["grep", "coder", "explore", true]
        )
        const everything = JSON.stringify(spans())
        assert.notInclude(everything, "secret")
        assert.notInclude(everything, "do it")
        assert.notInclude(everything, "done")
      })
  )

  it.effect(
    "a TOOL child carries the annotations of the scope it runs in, like any other span",
    () =>
      Effect.gen(function* () {
        const events = yield* makeFlowEventHub()
        const { tracer, spans } = recordingTracer()
        const seat = timedSeat(streaming, events, "coder")
        yield* Effect.annotateSpans(
          attr.story,
          "a"
        )(collect(seat.executeStreamWithHistory([user]))).pipe(Effect.withTracer(tracer))
        const tool = spans().find((span) => span.attributes[kindAttribute] === "TOOL")
        assert.strictEqual(tool?.attributes[attr.story], "a")
        const llm = spans().find((span) => span.attributes[kindAttribute] === "LLM")
        assert.strictEqual(llm?.attributes[attr.story], "a")
      })
  )

  it.effect(
    "content on: prompt, reply, tool arguments and outputs travel; the system prompt does not",
    () =>
      Effect.gen(function* () {
        const events = yield* makeFlowEventHub()
        const { tracer, spans } = recordingTracer()
        const seat = timedSeat(streaming, events, "coder", { content: "on" })
        yield* collect(seat.executeStreamWithHistory([system, user])).pipe(
          Effect.withTracer(tracer)
        )
        const llm = spans().find((span) => span.attributes[kindAttribute] === "LLM")
        assert.strictEqual(llm?.attributes[attr.output], "done")
        assert.include(String(llm?.attributes[attr.input]), "do it")
        assert.notInclude(String(llm?.attributes[attr.input]), "rules")
        const tool = spans().find((span) => span.attributes[kindAttribute] === "TOOL")
        assert.include(String(tool?.attributes[attr.input]), "secret")
        assert.include(String(tool?.attributes[attr.output]), "src/a.ts")
      })
  )

  it.effect("content full: the system prompt travels too", () =>
    Effect.gen(function* () {
      const events = yield* makeFlowEventHub()
      const { tracer, spans } = recordingTracer()
      const seat = timedSeat(streaming, events, "coder", { content: "full" })
      yield* collect(seat.executeStreamWithHistory([system, user])).pipe(Effect.withTracer(tracer))
      const llm = spans().find((span) => span.attributes[kindAttribute] === "LLM")
      assert.include(String(llm?.attributes[attr.input]), "rules")
    })
  )

  it.effect(
    "a backend that reports no usage gets an estimate on the span, flagged, with a clean model name",
    () =>
      Effect.gen(function* () {
        const events = yield* makeFlowEventHub()
        const { tracer, spans } = recordingTracer()
        const silent = serviceOf({
          executeStreamWithHistory: () =>
            chunks(LlmChunk.make({ delta: "x".repeat(400), finishReason: "stop" }))
        })
        const seat = timedSeat(silent, events, "coder", {
          estimate: { referenceModel: "claude-sonnet-4" }
        })
        yield* collect(
          seat.executeStreamWithHistory([Message.make({ role: "User", content: "y".repeat(800) })])
        ).pipe(Effect.withTracer(tracer))
        const llm = spans().find((span) => span.attributes[kindAttribute] === "LLM")
        assert.strictEqual(llm?.attributes[attr.estimated], true)
        assert.strictEqual(llm?.attributes[attr.model], "claude-sonnet-4")
        assert.isAbove(Number(llm?.attributes[attr.inputTokens]), 0)
        assert.isUndefined(llm?.attributes[attr.costUsd])
      })
  )

  it.effect("structured calls are LLM spans too, under the caller's role", () =>
    Effect.gen(function* () {
      const events = yield* makeFlowEventHub()
      const { tracer, spans } = recordingTracer()
      const seat = timedSeat(
        serviceOf({
          executeStructured: <A, E, RD, RE>(
            _prompt: string,
            schema: Schema.ConstraintCodec<A, E, RD, RE>
          ) => Schema.decodeUnknownEffect(schema)("ok").pipe(Effect.mapError(() => unused))
        }),
        events,
        "reasoning"
      )
      yield* withTimedRole("judge", seat.executeStructured("q", Schema.String, {})).pipe(
        Effect.withTracer(tracer)
      )
      const llm = spans().find((span) => span.attributes[kindAttribute] === "LLM")
      assert.deepStrictEqual([llm?.name, llm?.attributes[attr.role]], ["judge", "judge"])
    })
  )
  it.effect("a call says it began before it ends, streamed or structured", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const seat = timedSeat(
        serviceOf({
          executeStream: () => Stream.make(chunk("ok")),
          executeStructured: <A, E, RD, RE>(
            _prompt: string,
            schema: Schema.ConstraintCodec<A, E, RD, RE>
          ) => Schema.decodeUnknownEffect(schema)("ok").pipe(Effect.mapError(() => unused))
        }),
        events,
        "coder"
      )
      yield* collect(seat.executeStream("hi"))
      yield* withTimedRole("judge", seat.executeStructured("q", Schema.String, {}))
      const timeline = (yield* events.recorded).flatMap((event) =>
        event._tag === "Began" || event._tag === "Timed"
          ? [`${event._tag} ${event.kind} ${event.label}`]
          : []
      )
      assert.deepStrictEqual(timeline, [
        "Began model coder",
        "Timed model coder",
        "Began model judge",
        "Timed model judge"
      ])
    })
  )

  it.effect("structured calls carry the prompt and the decoded reply when content is on", () =>
    Effect.gen(function* () {
      const events = yield* makeFlowEventHub()
      const { tracer, spans } = recordingTracer()
      const structured = serviceOf({
        executeStructuredWithUsage: <A, E, RD, RE>(
          _prompt: string,
          schema: Schema.ConstraintCodec<A, E, RD, RE>
        ) =>
          Effect.map(
            Schema.decodeUnknownEffect(schema)({ verdict: "approve" }).pipe(
              Effect.mapError(() => unused)
            ),
            (value) => [value, undefined, "gemini-2.5-pro"] as const
          )
      })
      const Verdict = Schema.Struct({ verdict: Schema.String })
      const quiet = timedSeat(structured, events, "reviewer")
      yield* quiet
        .executeStructuredWithUsage("review this diff", Verdict, {})
        .pipe(Effect.withTracer(tracer))
      assert.notInclude(JSON.stringify(spans()), "review this diff")
      assert.notInclude(JSON.stringify(spans()), "approve")
      const { tracer: shown, spans: shownSpans } = recordingTracer()
      const seat = timedSeat(structured, events, "reviewer", { content: "on" })
      yield* seat
        .executeStructuredWithUsage("review this diff", Verdict, {})
        .pipe(Effect.withTracer(shown))
      const llm = shownSpans().find((span) => span.attributes[kindAttribute] === "LLM")
      assert.include(String(llm?.attributes[attr.input]), "review this diff")
      assert.strictEqual(llm?.attributes[attr.output], '{"verdict":"approve"}')
      assert.include(String(llm?.attributes[attr.outputMessages]), "approve")
    })
  )
})
