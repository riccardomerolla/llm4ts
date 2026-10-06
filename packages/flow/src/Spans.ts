// The vocabulary every llm4ts span speaks (ADR 0026): OpenTelemetry GenAI
// attributes first, OpenInference's span kind and token keys beside them so
// Phoenix of any version renders the LLM views, and llm4ts's own keys for
// what no convention names (role, story, epic, estimated usage). Pure: the
// exporter is the runner's, the seams only call `withKindSpan`.
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type * as Tracer from "effect/Tracer"
import type { TokenUsage } from "@llm4ts/core/Models"
import { isEstimatedModel } from "./EstimatedUsage.ts"

export type SpanKind = "CHAIN" | "AGENT" | "LLM" | "TOOL" | "EVALUATOR"

export const kindAttribute = "openinference.span.kind"

export const attr = {
  role: "llm4ts.role",
  executor: "llm4ts.executor",
  story: "llm4ts.story",
  epic: "llm4ts.epic",
  flow: "llm4ts.flow",
  run: "llm4ts.run",
  session: "session.id",
  toolCategory: "llm4ts.tool.category",
  estimated: "llm4ts.usage.estimated",
  costUsd: "llm4ts.cost.usd",
  costSource: "llm4ts.cost.source",
  gateCommand: "llm4ts.gate.command",
  gateExit: "llm4ts.gate.exit_code",
  model: "gen_ai.request.model",
  provider: "gen_ai.provider.name",
  operation: "gen_ai.operation.name",
  inputTokens: "gen_ai.usage.input_tokens",
  outputTokens: "gen_ai.usage.output_tokens",
  oiModel: "llm.model_name",
  oiPrompt: "llm.token_count.prompt",
  oiCompletion: "llm.token_count.completion",
  oiTotal: "llm.token_count.total",
  input: "input.value",
  output: "output.value",
  inputMessages: "gen_ai.input.messages",
  outputMessages: "gen_ai.output.messages"
} as const

/** How much content leaves the machine: nothing, prompts and tools, or the system prompt too. */
export type OtelContent = "off" | "on" | "full"

/** LLM4TS_OTEL_CONTENT: `on` or `full`; anything else is off. */
export const otelContent = (
  environment: Readonly<Record<string, string | undefined>>
): OtelContent => {
  const value = environment.LLM4TS_OTEL_CONTENT?.trim().toLowerCase()
  return value === "on" ? "on" : value === "full" ? "full" : "off"
}

export interface SpanOptions {
  readonly kind: SpanKind
  /** Start a new trace here (a story), linked to the span it was started from. */
  readonly root?: boolean
  readonly attributes?: Readonly<Record<string, unknown>>
}

/**
 * The nearest span `withKindSpan` opened. Effect names a span for every
 * `Effect.fn`, so the fiber's current span is usually an internal one; kind
 * spans chain to each other instead, and the runner leaves the internal ones
 * unsampled, so an exported trace shows the flow, not the call stack.
 */
const CurrentKindSpan = Context.Reference<Option.Option<Tracer.Span>>(
  "@llm4ts/flow/Spans/CurrentKindSpan",
  { defaultValue: () => Option.none() }
)

/** The kind span the current code runs under, when there is one. */
export const currentKindSpan: Effect.Effect<Option.Option<Tracer.Span>> = CurrentKindSpan

/**
 * A span with the OpenInference kind set, parented to the nearest kind span
 * (or rooting a new trace, linked to it), always sampled, ended with the
 * effect's exit.
 */
export const withKindSpan = <A, E, R>(
  name: string,
  options: SpanOptions,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
  Effect.scoped(
    Effect.gen(function* () {
      const parent = yield* CurrentKindSpan
      const span = yield* Effect.makeSpanScoped(name, {
        kind: options.kind === "LLM" ? "client" : "internal",
        sampled: true,
        ...(options.root === true
          ? {
              root: true,
              ...(Option.isSome(parent) ? { links: [{ span: parent.value, attributes: {} }] } : {})
            }
          : Option.isSome(parent)
            ? { parent: parent.value }
            : {}),
        attributes: { [kindAttribute]: options.kind, ...(options.attributes ?? {}) }
      })
      return yield* Effect.withParentSpan(
        Effect.provideService(effect, CurrentKindSpan, Option.some(span)),
        span
      )
    })
  )

/** The model name a backend would price: the estimate label stripped. */
export const modelNameOf = (model: string | undefined): string | undefined =>
  model === undefined
    ? undefined
    : isEstimatedModel(model)
      ? model.replace(/^estimated:/u, "")
      : model

/**
 * Token and cost attributes for one model call; `{}` when nothing is known.
 * A cost travels only when the backend reported it on measured usage: the
 * backends price estimates themselves from the model name.
 */
export const usageAttributes = (
  model: string | undefined,
  usage: TokenUsage | undefined,
  estimated: boolean
): Record<string, unknown> => {
  const name = modelNameOf(model)
  if (name === undefined && usage === undefined) {
    return {}
  }
  return {
    ...(name === undefined ? {} : { [attr.model]: name, [attr.oiModel]: name }),
    ...(usage === undefined
      ? {}
      : {
          [attr.inputTokens]: usage.prompt,
          [attr.outputTokens]: usage.completion,
          [attr.oiPrompt]: usage.prompt,
          [attr.oiCompletion]: usage.completion,
          [attr.oiTotal]: usage.total,
          ...(usage.costUsd === undefined || estimated
            ? {}
            : { [attr.costUsd]: usage.costUsd, [attr.costSource]: "reported" })
        }),
    [attr.estimated]: estimated
  }
}
