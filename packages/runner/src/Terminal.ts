import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Semaphore from "effect/Semaphore"
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
    const escapedCsi = code === 27 && value.charAt(index + 1) === "["
    if (escapedCsi || code === 155) {
      index += escapedCsi ? 2 : 1
      while (index < value.length) {
        const terminator = value.charCodeAt(index)
        if (terminator >= 64 && terminator <= 126) {
          break
        }
        index += 1
      }
      continue
    }
    const escapedOsc = code === 27 && value.charAt(index + 1) === "]"
    if (escapedOsc || code === 157) {
      index += escapedOsc ? 2 : 1
      while (index < value.length) {
        const current = value.charCodeAt(index)
        if (current === 7) {
          break
        }
        if (current === 27 && value.charAt(index + 1) === "\\") {
          index += 1
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

const Ansi = Object.freeze({
  reset: "\u001b[0m",
  boldMagenta: "\u001b[1;35m",
  green: "\u001b[32m",
  red: "\u001b[31m",
  yellowBold: "\u001b[1;33m",
  darkGray: "\u001b[90m"
})

export interface TerminalPalette {
  readonly enabled: boolean
  readonly stageStart: (label: string) => string
  readonly stageDone: (label: string) => string
  readonly fail: (label: string) => string
  readonly info: (label: string) => string
  readonly assistant: (text: string) => string
  readonly toolCall: (tool: string, args: string) => string
  readonly status: (frame: string, label: string) => string
}

export const makeTerminalPalette = (enabled: boolean): TerminalPalette => {
  const paint = (code: string, text: string): string =>
    enabled ? `${code}${text}${Ansi.reset}` : text
  return {
    enabled,
    stageStart: (label) => `${paint(Ansi.boldMagenta, "▶ ")}${label}`,
    stageDone: (label) => `${paint(Ansi.green, "✔ ")}${label}`,
    fail: (label) => `${paint(Ansi.red, "✖ ")}${label}`,
    info: (label) => paint(Ansi.darkGray, `· ${label}`),
    assistant: (text) => `${paint(Ansi.boldMagenta, "● ")}${text}`,
    toolCall: (tool, args) => {
      const head = paint(Ansi.yellowBold, `● ${tool}`)
      return args.length === 0 ? head : `${head} ${paint(Ansi.darkGray, args)}`
    },
    status: (frame, label) => `${paint(Ansi.boldMagenta, frame)} ${label}`
  }
}

export const plainTerminalPalette = makeTerminalPalette(false)

export const terminalLine = (
  event: FlowEvent,
  palette: TerminalPalette = plainTerminalPalette
): string => {
  const safe = terminalSafe
  switch (event._tag) {
    case "StageStarted":
      return palette.stageStart(safe(event.stage))
    case "StageCompleted":
      return palette.stageDone(safe(event.stage))
    case "StageFailed":
      return palette.fail(`${safe(event.stage)} — ${safe(event.message)}`)
    case "Aborted":
      return palette.fail(`aborted: ${safe(event.message)}`)
    case "Info":
      return palette.info(safe(event.message))
    case "ToolUse":
      return palette.toolCall(safe(event.tool), safe(event.args))
    case "AssistantMessage":
      return palette.assistant(safe(event.text).trim())
    case "TokensUsed":
      return palette.info(
        `tokens: ${safe(event.agent)} ${event.usage.prompt} in / ${event.usage.completion} out`
      )
    case "CapabilityUsed":
      return palette.info(`capability ${safe(event.capability)}: ${safe(event.operation)}`)
    case "CapabilityDenied":
      return palette.fail(
        `capability denied: ${safe(event.capability)} for ${safe(event.operation)}`
      )
    case "CapabilityUnenforceable":
      return palette.fail(`capability unenforceable: ${safe(event.detail)}`)
    case "Declassified":
      return palette.info(`declassified: ${safe(event.label)}`)
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
  readonly palette: TerminalPalette
  readonly log: (line: string) => Effect.Effect<void>
  readonly setStatus: (label: string | undefined) => Effect.Effect<void>
  readonly suspend: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

export const makePlainTerminalSurface = (
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)
): TerminalSurface => ({
  palette: plainTerminalPalette,
  log: (line) => Effect.sync(() => write(line)),
  setStatus: (_label) => Effect.void,
  suspend: (effect) => effect
})

const spinnerFrames = Object.freeze(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"])
const clearLine = "\r\u001b[2K"

export interface TerminalOutput {
  readonly isTTY?: boolean
  readonly write: (text: string) => unknown
}

export const terminalSupportsColor = (
  output: TerminalOutput,
  environment: Readonly<Record<string, string | undefined>>
): boolean => output.isTTY === true && environment.NO_COLOR === undefined

export const makeLiveTerminalSurface = Effect.fn("@llm4ts/runner/Terminal.makeLive")(function* (
  write: (text: string) => void = (text) => {
    process.stdout.write(text)
  },
  palette: TerminalPalette = makeTerminalPalette(true),
  tick: Duration.Input = "100 millis"
): Effect.fn.Return<TerminalSurface, never, Scope.Scope> {
  const lock = yield* Semaphore.make(1)
  const status = yield* Ref.make<string | undefined>(undefined)
  const frame = yield* Ref.make(0)
  const suspended = yield* Ref.make(false)
  const emit = (text: string): Effect.Effect<void> => Effect.sync(() => write(text))
  const drawStatus = Effect.gen(function* () {
    if (yield* Ref.get(suspended)) {
      return
    }
    const label = yield* Ref.get(status)
    if (label !== undefined) {
      const currentFrame = yield* Ref.get(frame)
      yield* emit(
        `${clearLine}${palette.status(spinnerFrames[currentFrame % spinnerFrames.length], label)}`
      )
    }
  })
  const surface: TerminalSurface = {
    palette,
    log: (line) =>
      lock.withPermit(
        emit(clearLine).pipe(Effect.andThen(emit(`${line}\n`)), Effect.andThen(drawStatus))
      ),
    setStatus: (label) =>
      lock.withPermit(
        Ref.set(status, label).pipe(Effect.andThen(emit(clearLine)), Effect.andThen(drawStatus))
      ),
    suspend: (effect) =>
      lock
        .withPermit(Ref.set(suspended, true).pipe(Effect.andThen(emit(clearLine))))
        .pipe(
          Effect.andThen(effect),
          Effect.ensuring(
            lock.withPermit(Ref.set(suspended, false).pipe(Effect.andThen(drawStatus)))
          )
        )
  }
  yield* Effect.sleep(tick).pipe(
    Effect.andThen(Ref.update(frame, (current) => current + 1)),
    Effect.andThen(lock.withPermit(drawStatus)),
    Effect.forever,
    Effect.forkScoped
  )
  yield* Effect.addFinalizer(() => lock.withPermit(emit(clearLine)))
  return surface
})

export const makeTerminalSurface = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
  output: TerminalOutput = process.stdout
): Effect.Effect<TerminalSurface, never, Scope.Scope> => {
  const write = (text: string): void => {
    output.write(text)
  }
  return terminalSupportsColor(output, environment)
    ? makeLiveTerminalSurface(write)
    : Effect.succeed(makePlainTerminalSurface((line) => write(`${line}\n`)))
}

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
  const stages = yield* Ref.make<ReadonlyArray<string>>([])
  const consumed = yield* Ref.make(0)
  const subscription = yield* events.subscribe
  const palette = surface.palette
  yield* Stream.fromSubscription(subscription).pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        const currentDepth = closesChild(event)
          ? yield* Ref.updateAndGet(depth, (value) => Math.max(0, value - 1))
          : yield* Ref.get(depth)
        if (event._tag === "StageStarted") {
          yield* Ref.update(depth, (value) => value + 1)
          const active = terminalSafe(event.stage)
          yield* Ref.update(stages, (current) => [...current, active])
          yield* surface.setStatus(active)
        } else if (closesChild(event)) {
          const remaining = yield* Ref.updateAndGet(stages, (current) => current.slice(0, -1))
          yield* surface.setStatus(remaining.at(-1))
        }
        if (rendersEvent(verbosity, event)) {
          yield* surface.log(indentBlock(currentDepth, terminalLine(event, palette)))
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
