import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import { FlowLlmError, type FlowError } from "./FlowError.ts"
import { FlowEvents, Info } from "./FlowEvents.ts"
import { isContextOverflow, isContextOverflowMessage } from "./TransientRetry.ts"

// Context budgeting for LLM prompts: bound what a call ships, and make every
// truncation visible. Budgets are in CHARACTERS, not tokens — deterministic, no
// tokenizer dependency. Rule of thumb ~3.5 chars/token for code, so the 400k
// default is ~115k tokens: conservative against every provider.

const marker = "\n\n… [truncated] …\n\n"

export interface CappedText {
  readonly text: string
  readonly originalChars: number
  readonly truncated: boolean
}

/**
 * Bound `text` to `limit` characters — the result is NEVER longer than `limit`,
 * marker included. Keeps the head (3/4 of the remaining room) and the tail (1/4)
 * so both the entry points and the trailing rules survive; the middle is where
 * boilerplate lives. For `limit <= 0` the closest achievable result is the
 * empty string, since length can't go negative.
 */
export const cap = (text: string, limit: number): CappedText => {
  if (text.length <= limit) {
    return { text, originalChars: text.length, truncated: false }
  }
  if (limit <= marker.length) {
    return { text: text.slice(0, Math.max(limit, 0)), originalChars: text.length, truncated: true }
  }
  const room = limit - marker.length
  const head = Math.floor((room * 3) / 4)
  const tail = room - head
  return {
    text: `${text.slice(0, head)}${marker}${text.slice(text.length - tail)}`,
    originalChars: text.length,
    truncated: true
  }
}

export const defaultContextBudget = 400_000

/**
 * The default character budget: `LLM4TS_CONTEXT_BUDGET`, else the deprecated
 * `LLM4TS_JUDGE_SOURCES_LIMIT`, else 400_000.
 */
export const budget = (
  environment: Readonly<Record<string, string | undefined>> = process.env
): number => {
  const raw = environment["LLM4TS_CONTEXT_BUDGET"] ?? environment["LLM4TS_JUDGE_SOURCES_LIMIT"]
  if (raw === undefined) {
    return defaultContextBudget
  }
  const parsed = Number.parseInt(raw.trim(), 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : defaultContextBudget
}

/**
 * Which kind of shrinking produced a truncation — the two are NOT
 * interchangeable. "capped" numbers are literal character counts of shortened
 * text; "shrunk" numbers are attempted budget CEILINGS after an oversized
 * prompt failed. Conflating them would misreport how much content a
 * clean-room audit actually lost.
 */
export type TruncationKind = "capped" | "shrunk"

export interface Truncation {
  readonly label: string
  readonly originalChars: number
  readonly keptChars: number
  readonly kind: TruncationKind
}

export const renderTruncation = (truncation: Truncation): string =>
  truncation.kind === "capped"
    ? `${truncation.label}: truncated ${truncation.originalChars} → ${truncation.keptChars} chars`
    : `${truncation.label}: retried at a lower budget, ${truncation.originalChars} → ${truncation.keptChars} chars (ceilings, not text size)`

// The ambient truncation log, written only by `capped` and `withShrink` so no
// call site can truncate without recording. The Reference default is a single
// process-wide cell; `isolateTruncations` scopes a fresh one so concurrent
// flows don't cross-contaminate and a phase reads back exactly what its own
// calls truncated.
const CurrentTruncations = Context.Reference<Ref.Ref<ReadonlyArray<Truncation>>>(
  "@llm4ts/flow/Context/CurrentTruncations",
  { defaultValue: () => Ref.makeUnsafe<ReadonlyArray<Truncation>>([]) }
)

const record = (truncation: Truncation): Effect.Effect<void> =>
  Effect.flatMap(Effect.service(CurrentTruncations), (log) =>
    Ref.update(log, (recorded) => [...recorded, truncation])
  )

/** Truncations recorded so far. Phases write these into `provenance.json`. */
export const truncations: Effect.Effect<ReadonlyArray<Truncation>> = Effect.flatMap(
  Effect.service(CurrentTruncations),
  Ref.get
)

/** Run `effect` against a fresh, private truncation log. */
export const isolateTruncations = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
  Effect.flatMap(Ref.make<ReadonlyArray<Truncation>>([]), (fresh) =>
    Effect.provideService(effect, CurrentTruncations, fresh)
  )

/**
 * `cap`, publishing a `FlowEvent` and recording the truncation when one
 * happens. `label` names what was shortened, so the event and the provenance
 * entry are readable ("specs", "branch diff", "judge context").
 */
export const capped = Effect.fn("@llm4ts/flow/Context.capped")(function* (
  label: string,
  text: string,
  limit: number
): Effect.fn.Return<string, never, FlowEvents> {
  const out = cap(text, limit)
  if (!out.truncated) {
    return out.text
  }
  const events = yield* FlowEvents
  yield* events.publish(
    Info.make({
      message: `⚠ context: ${label} truncated ${out.originalChars} → ${out.text.length} chars`
    })
  )
  yield* record({
    label,
    originalChars: out.originalChars,
    keptChars: out.text.length,
    kind: "capped"
  })
  return out.text
})

// True for the two failure classes a smaller prompt can fix: a deterministic
// context overflow, and the empty response gemini returns when a prompt is too
// large for it to even start. The overflow check delegates to TransientRetry's
// phrasing list so a message-only failure (no surviving typed LlmError) is
// still caught — a second, shorter copy here would drift.
const shrinkable = (error: FlowError): boolean =>
  error._tag === "Llm" &&
  ((error.cause !== undefined && isContextOverflow(error.cause)) ||
    isContextOverflowMessage(error.message) ||
    error.message.toLowerCase().includes("empty response"))

export interface WithShrinkOptions {
  readonly start?: number
  readonly environment?: Readonly<Record<string, string | undefined>>
}

/**
 * Run `f` at `start` characters (default: `budget()`); on a shrinkable failure
 * retry at 1/2, then 1/4, then give up. Repeating the same oversized prompt
 * cannot succeed, so shrinking is the only retry that makes sense for this
 * failure class — which is why context overflow is deliberately excluded from
 * `TransientRetry`'s budget. Each shrink publishes a `FlowEvent` and is
 * recorded like any other truncation. The terminal failure deliberately drops
 * the typed cause: a resume layer classifying an "empty response" cause as
 * flaky would replay this exact, permanently-failing budget sequence forever.
 */
export const withShrink = <A, E extends FlowError, R>(
  label: string,
  f: (chars: number) => Effect.Effect<A, E, R>,
  options: WithShrinkOptions = {}
): Effect.Effect<A, E | FlowLlmError, R | FlowEvents> => {
  const start = options.start ?? budget(options.environment)
  const attempt = (
    atChars: number,
    rest: ReadonlyArray<number>
  ): Effect.Effect<A, E | FlowLlmError, R | FlowEvents> =>
    Effect.catchIf(
      f(atChars),
      () => true,
      (error): Effect.Effect<A, E | FlowLlmError, R | FlowEvents> => {
        if (!shrinkable(error)) {
          return Effect.fail(error)
        }
        if (rest.length === 0) {
          return Effect.fail(
            FlowLlmError.make({
              message:
                `${label} exceeded the model's input limit even after shrinking to ${atChars} chars — ` +
                `lower LLM4TS_CONTEXT_BUDGET or scope this phase further (cause: ${error.message})`
            })
          )
        }
        const [next, ...remaining] = rest
        return Effect.gen(function* () {
          const events = yield* FlowEvents
          yield* events.publish(
            Info.make({
              message: `⚠ context: ${label} did not fit at ${atChars} chars — shrinking to ${next}: ${error.message}`
            })
          )
          yield* record({ label, originalChars: atChars, keptChars: next, kind: "shrunk" })
          return yield* attempt(next, remaining)
        })
      }
    )
  return attempt(start, [Math.floor(start / 2), Math.floor(start / 4)])
}
