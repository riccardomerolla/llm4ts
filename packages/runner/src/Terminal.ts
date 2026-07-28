import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import type * as Scope from "effect/Scope"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import type { FlowEvent, FlowEventHub } from "@llm4ts/flow/FlowEvents"

export const Verbosity = Schema.Literals(["Quiet", "Normal", "Verbose", "Debug"])
export type Verbosity = typeof Verbosity.Type

export const parseVerbosity = (value: string | undefined): Verbosity => {
  switch (value?.trim().toLowerCase()) {
    case "quiet":
      return "Quiet"
    case "verbose":
      return "Verbose"
    case "debug":
      return "Debug"
    default:
      return "Normal"
  }
}

export const rendersEvent = (verbosity: Verbosity, event: FlowEvent): boolean => {
  switch (event._tag) {
    case "StageStarted":
    case "StageCompleted":
    case "StageFailed":
    case "Aborted":
    case "CapabilityDenied":
    case "CapabilityUnenforceable":
      return true
    case "TokensUsed":
      return verbosity === "Verbose" || verbosity === "Debug"
    default:
      return verbosity !== "Quiet"
  }
}

export const terminalSafe = (value: string): string => {
  let safe = ""
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code === 27 && value.charAt(index + 1) === "[") {
      index += 2
      while (index < value.length) {
        const terminator = value.charCodeAt(index)
        if (terminator >= 64 && terminator <= 126) {
          break
        }
        index += 1
      }
      continue
    }
    const allowedWhitespace = code === 9 || code === 10 || code === 13
    if (allowedWhitespace || (code >= 32 && !(code >= 127 && code <= 159))) {
      safe += value.charAt(index)
    }
  }
  return safe
}

export const terminalLine = (event: FlowEvent): string => {
  const safe = terminalSafe
  switch (event._tag) {
    case "StageStarted":
      return `▶ ${safe(event.stage)}`
    case "StageCompleted":
      return `✔ ${safe(event.stage)}`
    case "StageFailed":
      return `✖ ${safe(event.stage)} — ${safe(event.message)}`
    case "Aborted":
      return `✖ aborted: ${safe(event.message)}`
    case "Info":
      return `· ${safe(event.message)}`
    case "ToolUse":
      return `● ${safe(event.tool)} ${safe(event.args)}`.trimEnd()
    case "AssistantMessage":
      return `● ${safe(event.text).trim()}`
    case "TokensUsed":
      return `· tokens: ${safe(event.agent)} ${event.usage.prompt} in / ${event.usage.completion} out`
    case "CapabilityUsed":
      return `· capability ${safe(event.capability)}: ${safe(event.operation)}`
    case "CapabilityDenied":
      return `✖ capability denied: ${safe(event.capability)} for ${safe(event.operation)}`
    case "CapabilityUnenforceable":
      return `✖ capability unenforceable: ${safe(event.detail)}`
    case "Declassified":
      return `· declassified: ${safe(event.label)}`
  }
}

export const indentBlock = (depth: number, rendered: string): string => {
  const padding = "  ".repeat(Math.max(0, depth))
  const lines = rendered.split("\n")
  return lines.map((line, index) => `${padding}${index === 0 ? "" : "  "}${line}`).join("\n")
}

const closesChild = (event: FlowEvent): boolean =>
  event._tag === "StageCompleted" || event._tag === "StageFailed" || event._tag === "Aborted"

export const indentDepths = (events: ReadonlyArray<FlowEvent>): ReadonlyArray<number> => {
  let depth = 0
  return events.map((event) => {
    if (closesChild(event)) {
      depth = Math.max(0, depth - 1)
      return depth
    }
    const current = depth
    if (event._tag === "StageStarted") {
      depth += 1
    }
    return current
  })
}

export interface TerminalSurface {
  readonly log: (line: string) => Effect.Effect<void>
  readonly setStatus: (label: string | undefined) => Effect.Effect<void>
  readonly suspend: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

export const makePlainTerminalSurface = (
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)
): TerminalSurface => ({
  log: (line) => Effect.sync(() => write(line)),
  setStatus: (_label) => Effect.void,
  suspend: (effect) => effect
})

export interface TerminalConsumer {
  readonly consumed: Ref.Ref<number>
  readonly awaitDrained: (timeout?: Duration.Input) => Effect.Effect<void>
}

export const consumeTerminalEvents = Effect.fn("@llm4ts/runner/Terminal.consume")(function* (
  events: FlowEventHub,
  surface: TerminalSurface,
  verbosity: Verbosity = "Normal"
): Effect.fn.Return<TerminalConsumer, never, Scope.Scope> {
  const depth = yield* Ref.make(0)
  const consumed = yield* Ref.make(0)
  const subscription = yield* events.subscribe
  yield* Stream.fromSubscription(subscription).pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        const currentDepth = closesChild(event)
          ? yield* Ref.updateAndGet(depth, (value) => Math.max(0, value - 1))
          : yield* Ref.get(depth)
        if (event._tag === "StageStarted") {
          yield* Ref.update(depth, (value) => value + 1)
          yield* surface.setStatus(event.stage)
        } else if (closesChild(event)) {
          yield* surface.setStatus(undefined)
        }
        if (rendersEvent(verbosity, event)) {
          yield* surface.log(indentBlock(currentDepth, terminalLine(event)))
        }
        yield* Ref.update(consumed, (count) => count + 1)
      })
    ),
    Effect.forkScoped
  )
  const awaitDrained = (timeout: Duration.Input = "3 seconds"): Effect.Effect<void> =>
    Effect.gen(function* () {
      const target = yield* events.publishedCount
      const drain: Effect.Effect<void> = Effect.suspend(() =>
        Ref.get(consumed).pipe(
          Effect.flatMap((count) =>
            count >= target ? Effect.void : Effect.yieldNow.pipe(Effect.andThen(drain))
          )
        )
      )
      yield* Effect.timeoutOption(drain, timeout)
    })
  return { consumed, awaitDrained }
})
