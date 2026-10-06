import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Stream from "effect/Stream"
import type * as Tracer from "effect/Tracer"
import type { JudgmentShape } from "@llm4ts/core/judgment/Judgment"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import { Message, type LlmChunk, type TokenUsage } from "@llm4ts/core/Models"
import { redactText } from "@llm4ts/core/observability/Redaction"
import { toolCategory } from "./Activity.ts"
import { estimateUsage, estimatedModelLabel, type EstimatedUsageOptions } from "./EstimatedUsage.ts"
import { Timed, type FlowEventsShape } from "./FlowEvents.ts"
import {
  attr,
  currentKindSpan,
  kindAttribute,
  usageAttributes,
  withKindSpan,
  type OtelContent
} from "./Spans.ts"

/**
 * Where a run's time goes. `timedSeat` decorates a seat so every
 * call publishes a `Timed{kind:"model"}` when it ends — its wall time, when
 * its first output came, and the API and tool time the backend reported, if
 * it did. The events carry the seat's role, never the prompt or the reply.
 *
 * The same decorator makes every call an LLM span (ADR 0026) with the GenAI
 * usage attributes, each harness tool call a TOOL child of it, and the four
 * counters below; content joins the spans only when `content` says so.
 */

export interface TimedSeatOptions {
  /** Who serves the seat, read at each call (a roster hands the coder over). */
  readonly executor?: Effect.Effect<string | undefined>
  /** What content the spans may carry (ADR 0026); off by default. */
  readonly content?: OtelContent
  /** When set, a call the backend reports no usage for gets an estimate on its span, flagged. */
  readonly estimate?: EstimatedUsageOptions
}

const tokensCounter = Metric.counter("llm4ts.tokens", {
  description: "tokens by model, role, executor and direction",
  incremental: true
})
const costCounter = Metric.counter("llm4ts.cost.usd", {
  description: "cost the backend reported, USD",
  incremental: true
})
const callsCounter = Metric.counter("llm4ts.model.calls", {
  description: "model calls by role and executor",
  incremental: true
})
const toolCallsCounter = Metric.counter("llm4ts.tool.calls", {
  description: "harness tool calls by kind of work",
  incremental: true
})

const inputChars = 64_000
const partChars = 4_000

const clean = (text: string, limit: number): string => redactText(text, { maxLength: limit })

/** The prompt as content attributes, or nothing: the system prompt only under `full`. */
const promptContent = (
  content: OtelContent,
  messages: ReadonlyArray<Message>
): Record<string, unknown> => {
  if (content === "off") {
    return {}
  }
  const shown = messages.filter((message) => content === "full" || message.role !== "System")
  return {
    [attr.input]: clean(
      shown.map((message) => `${message.role}: ${message.content}`).join("\n\n"),
      inputChars
    ),
    [attr.inputMessages]: JSON.stringify(
      shown.map((message) => ({
        role: message.role.toLowerCase(),
        content: clean(message.content, inputChars)
      }))
    )
  }
}

const replyContent = (content: OtelContent, text: string): Record<string, unknown> =>
  content === "off"
    ? {}
    : {
        [attr.output]: clean(text, inputChars),
        [attr.outputMessages]: JSON.stringify([
          { role: "assistant", content: clean(text, inputChars) }
        ])
      }

const count = (
  counter: Metric.Counter<number>,
  attributes: Record<string, string>,
  by: number
): Effect.Effect<void> =>
  by === 0 ? Effect.void : Metric.update(by)(Metric.withAttributes(attributes)(counter))

/** The usage and the model a call ends with: measured from the chunks, else estimated when asked. */
const settleUsage = (
  measured: TokenUsage | undefined,
  model: string | undefined,
  promptChars: number,
  completionChars: number,
  estimate: EstimatedUsageOptions | undefined
): {
  readonly usage: TokenUsage | undefined
  readonly model: string | undefined
  readonly estimated: boolean
} =>
  measured !== undefined
    ? { usage: measured, model, estimated: false }
    : estimate === undefined
      ? { usage: undefined, model, estimated: false }
      : {
          usage: estimateUsage(promptChars, completionChars, estimate),
          model: model ?? estimatedModelLabel(estimate.referenceModel),
          estimated: true
        }

const recordCall = (
  role: string,
  executor: string | undefined,
  settled: ReturnType<typeof settleUsage>,
  failed: boolean
): Effect.Effect<void> => {
  const base = {
    role,
    executor: executor ?? "",
    model: settled.model ?? "",
    estimated: String(settled.estimated)
  }
  return Effect.all(
    [
      count(callsCounter, { role, executor: executor ?? "", failed: String(failed) }, 1),
      settled.usage === undefined
        ? Effect.void
        : Effect.all([
            count(tokensCounter, { ...base, direction: "input" }, settled.usage.prompt),
            count(tokensCounter, { ...base, direction: "output" }, settled.usage.completion),
            settled.estimated || settled.usage.costUsd === undefined
              ? Effect.void
              : count(
                  costCounter,
                  { role, executor: executor ?? "", model: settled.model ?? "" },
                  settled.usage.costUsd
                )
          ])
    ],
    { discard: true }
  )
}

/**
 * The role a call is made for, when it is not the seat's own: one seat
 * serves the reviewer, the story judge and the BLOCKED_ON verifier when no
 * roster splits them, and the report should still tell them apart.
 */
const TimedRole = Context.Reference<string | undefined>("@llm4ts/flow/Timing/TimedRole", {
  defaultValue: () => undefined
})

/** The role the current call is made for: the caller's, or else `label`. */
export const roleOr = (label: string): Effect.Effect<string> =>
  Effect.map(TimedRole, (role) => role ?? label)

/** Times the seat calls `effect` makes under `role` instead of the seat's own label. */
export const withTimedRole = <A, E, R>(role: string, effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, TimedRole, role)

const reportedMs = (chunk: LlmChunk, key: string): number | undefined => {
  const raw = chunk.metadata[key]
  const value = raw === undefined ? Number.NaN : Number(raw)
  return Number.isFinite(value) ? value : undefined
}

/** Times `effect`, publishing what `timed` makes of its duration whether it succeeds or fails. */
export const timeEffect = <A, E, R>(
  events: FlowEventsShape,
  effect: Effect.Effect<A, E, R>,
  timed: (ms: number, failed: boolean, role: string | undefined) => Timed
): Effect.Effect<A, E, R> =>
  Effect.flatMap(Effect.all([Clock.currentTimeMillis, TimedRole]), ([start, role]) =>
    Effect.onExit(effect, (exit) =>
      Effect.flatMap(Clock.currentTimeMillis, (end) =>
        events.publish(timed(end - start, Exit.isFailure(exit), role))
      )
    )
  )

/**
 * `timeEffect` under an LLM span named for the role; `usageOf` reads what
 * the result says about tokens and model, when it says anything.
 */
const tracedEffect = <A, E, R>(
  events: FlowEventsShape,
  label: string,
  options: TimedSeatOptions,
  effect: Effect.Effect<A, E, R>,
  timed: (ms: number, failed: boolean, role: string | undefined) => Timed,
  usageOf: (value: A) => {
    readonly usage: TokenUsage | undefined
    readonly model: string | undefined
  }
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const role = (yield* TimedRole) ?? label
    const executor = options.executor === undefined ? undefined : yield* options.executor
    return yield* withKindSpan(
      role,
      {
        kind: "LLM",
        attributes: {
          [attr.role]: role,
          [attr.operation]: "generate",
          ...(executor === undefined ? {} : { [attr.executor]: executor })
        }
      },
      timeEffect(events, effect, timed).pipe(
        Effect.onExit((exit) => {
          const known = Exit.isSuccess(exit)
            ? usageOf(exit.value)
            : { usage: undefined, model: undefined }
          const settled = settleUsage(known.usage, known.model, 0, 0, undefined)
          return Effect.all(
            [
              Effect.annotateCurrentSpan(
                usageAttributes(settled.model, settled.usage, settled.estimated)
              ),
              recordCall(role, executor, settled, Exit.isFailure(exit))
            ],
            { discard: true }
          )
        })
      )
    )
  })

const timedStream = <E>(
  events: FlowEventsShape,
  label: string,
  options: TimedSeatOptions,
  messages: ReadonlyArray<Message>,
  stream: Stream.Stream<LlmChunk, E>
): Stream.Stream<LlmChunk, E> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const start = yield* Clock.currentTimeMillis
      const role = (yield* TimedRole) ?? label
      const executor = options.executor === undefined ? undefined : yield* options.executor
      const content = options.content ?? "off"
      const first = yield* Ref.make<number | undefined>(undefined)
      const reported = yield* Ref.make<{ apiMs?: number; toolMs?: number }>({})
      const failed = yield* Ref.make(false)
      const usage = yield* Ref.make<TokenUsage | undefined>(undefined)
      const model = yield* Ref.make<string | undefined>(undefined)
      const reply = yield* Ref.make("")
      // The call's LLM span (ADR 0026), parented to the nearest kind span and
      // ended when the stream does; each harness tool call is a TOOL child,
      // opened on `tool_use` and closed on `tool_result`.
      const parent = yield* currentKindSpan
      const span = yield* Effect.makeSpan(role, {
        kind: "client",
        sampled: true,
        ...(Option.isSome(parent) ? { parent: parent.value } : {}),
        attributes: {
          [kindAttribute]: "LLM",
          [attr.role]: role,
          [attr.operation]: "chat",
          ...(executor === undefined ? {} : { [attr.executor]: executor }),
          ...promptContent(content, messages)
        }
      })
      const openTools = yield* Ref.make<
        ReadonlyArray<{ readonly id: string | undefined; readonly span: Tracer.Span }>
      >([])
      const toolStarted = (chunk: LlmChunk) =>
        Effect.gen(function* () {
          const tool = (chunk.metadata.tool_name ?? chunk.metadata.toolName ?? "").trim()
          if (tool.length === 0) {
            return
          }
          const args = chunk.metadata.tool_input ?? chunk.metadata.toolInput ?? ""
          const category = toolCategory(tool, args)
          // `Effect.makeSpan`, not the tracer directly: the scope's annotations
          // (story, epic, session) land on it like on every other span.
          const child = yield* Effect.makeSpan(tool, {
            parent: span,
            kind: "internal",
            sampled: true,
            attributes: {
              [kindAttribute]: "TOOL",
              [attr.toolCategory]: category,
              "tool.name": tool,
              ...(content === "off" ? {} : { [attr.input]: clean(args, partChars) })
            }
          })
          const id = chunk.metadata.tool_id ?? chunk.metadata.toolId
          yield* Ref.update(openTools, (open) => [
            ...open,
            { id: id === undefined || id.length === 0 ? undefined : id, span: child }
          ])
          yield* count(toolCallsCounter, { category }, 1)
        })
      const toolEnded = (chunk: LlmChunk) =>
        Effect.gen(function* () {
          const id = chunk.metadata.tool_id ?? chunk.metadata.toolId
          const found = yield* Ref.modify(openTools, (open) => {
            const index =
              id === undefined || id.length === 0 ? 0 : open.findIndex((entry) => entry.id === id)
            const entry = index < 0 ? undefined : open[index]
            return [
              entry,
              entry === undefined ? open : [...open.slice(0, index), ...open.slice(index + 1)]
            ] as const
          })
          if (found === undefined) {
            return
          }
          const toolFailed =
            chunk.metadata.tool_failed === "true" || chunk.metadata.tool_status === "error"
          if (content !== "off") {
            found.span.attribute(attr.output, clean(chunk.metadata.tool_content ?? "", partChars))
          }
          found.span.end(
            yield* Clock.currentTimeNanos,
            toolFailed ? Exit.fail("tool failed") : Exit.void
          )
        })
      return stream.pipe(
        Stream.tap((chunk) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            yield* Ref.update(first, (at) => at ?? now - start)
            const apiMs = reportedMs(chunk, "api_ms")
            const toolMs = reportedMs(chunk, "tools_ms")
            if (apiMs !== undefined || toolMs !== undefined) {
              yield* Ref.update(reported, (current) => ({
                ...current,
                ...(apiMs === undefined ? {} : { apiMs }),
                ...(toolMs === undefined ? {} : { toolMs })
              }))
            }
            if (chunk.usage !== undefined) {
              yield* Ref.set(usage, chunk.usage)
            }
            if (chunk.metadata.model !== undefined) {
              yield* Ref.set(model, chunk.metadata.model)
            }
            if (chunk.delta.length > 0) {
              yield* Ref.update(reply, (text) => text + chunk.delta)
            }
            if (chunk.metadata.event === "tool_use") {
              yield* toolStarted(chunk)
            } else if (chunk.metadata.event === "tool_result") {
              yield* toolEnded(chunk)
            }
          })
        ),
        Stream.tapError(() => Ref.set(failed, true)),
        Stream.ensuring(
          Effect.gen(function* () {
            const end = yield* Clock.currentTimeMillis
            const firstMs = yield* Ref.get(first)
            const didFail = yield* Ref.get(failed)
            yield* events.publish(
              Timed.make({
                kind: "model",
                label: role,
                ms: end - start,
                ...(firstMs === undefined ? {} : { firstMs }),
                ...(yield* Ref.get(reported)),
                ...(didFail ? { failed: true } : {})
              })
            )
            const text = yield* Ref.get(reply)
            const settled = settleUsage(
              yield* Ref.get(usage),
              yield* Ref.get(model),
              messages.reduce((sum, message) => sum + message.content.length, 0),
              text.length,
              options.estimate
            )
            for (const [key, value] of Object.entries({
              ...usageAttributes(settled.model, settled.usage, settled.estimated),
              ...replyContent(content, text)
            })) {
              span.attribute(key, value)
            }
            yield* recordCall(role, executor, settled, didFail)
            const nanos = yield* Clock.currentTimeNanos
            for (const entry of yield* Ref.get(openTools)) {
              entry.span.end(nanos, Exit.void)
            }
            span.end(nanos, didFail ? Exit.fail("stream failed") : Exit.void)
          })
        )
      )
    })
  )

export const timedSeat = (
  service: LlmServiceShape,
  events: FlowEventsShape,
  label: string,
  options: TimedSeatOptions = {}
): LlmServiceShape => {
  const model = (ms: number, failed: boolean, role: string | undefined): Timed =>
    Timed.make({ kind: "model", label: role ?? label, ms, ...(failed ? { failed: true } : {}) })
  const nothing = () => ({ usage: undefined, model: undefined })
  const prompt = (text: string): ReadonlyArray<Message> => [
    Message.make({ role: "User", content: text })
  ]
  const batched = service.scoreLabelSequence
  return {
    executeStream: (text) =>
      timedStream(events, label, options, prompt(text), service.executeStream(text)),
    executeStreamWithHistory: (messages) =>
      timedStream(events, label, options, messages, service.executeStreamWithHistory(messages)),
    executeWithTools: (text, tools) =>
      tracedEffect(events, label, options, service.executeWithTools(text, tools), model, nothing),
    executeStructured: (text, schema, jsonSchema) =>
      tracedEffect(
        events,
        label,
        options,
        service.executeStructured(text, schema, jsonSchema),
        model,
        nothing
      ),
    executeStructuredWithUsage: (text, schema, jsonSchema) =>
      tracedEffect(
        events,
        label,
        options,
        service.executeStructuredWithUsage(text, schema, jsonSchema),
        model,
        ([, usage, modelName]) => ({ usage, model: modelName })
      ),
    scoreLabels: (text, labels) =>
      tracedEffect(events, label, options, service.scoreLabels(text, labels), model, nothing),
    ...(batched === undefined
      ? {}
      : {
          scoreLabelSequence: (text: string, labelSets: ReadonlyArray<ReadonlyArray<string>>) =>
            tracedEffect(events, label, options, batched(text, labelSets), model, nothing)
        }),
    isAvailable: service.isAvailable
  }
}

/** Typed judgments (ADR 0017) timed as `judgment` calls, under the caller's role if it named one. */
export const timedJudgment = (judgment: JudgmentShape, events: FlowEventsShape): JudgmentShape => ({
  ...judgment,
  judge: (input) =>
    timeEffect(events, judgment.judge(input), (ms, failed, role) =>
      Timed.make({
        kind: "model",
        label: role ?? "judgment",
        ms,
        ...(failed ? { failed: true } : {})
      })
    )
})
