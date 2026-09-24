import { spawnSync } from "node:child_process"
import * as Clock from "effect/Clock"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Semaphore from "effect/Semaphore"
import type * as Scope from "effect/Scope"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import {
  awaitConsumed,
  type FlowEvent,
  type FlowEventHub,
  type ReviewFindings
} from "@llm4ts/flow/FlowEvents"

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
    // Advise mode publishes a separate Info event for the operator; progress
    // feeds the status rows. Neither is a line of its own.
    case "JudgmentObserved":
    case "UsageProgress":
      return false
    case "StageStarted":
    case "StageCompleted":
    case "StageFailed":
    case "Aborted":
    case "CapabilityDenied":
    case "CapabilityUnenforceable":
      return true
    // Every git read and gate command is a capability event: useful in a
    // trace, noise on screen once several stories run.
    case "TokensUsed":
    case "CapabilityUsed":
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
  cyan: "\u001b[36m",
  blue: "\u001b[34m",
  magenta: "\u001b[35m",
  yellow: "\u001b[33m",
  greenBold: "\u001b[1;32m",
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
  readonly warn: (label: string) => string
  readonly info: (label: string) => string
  readonly dim: (text: string) => string
  readonly assistant: (text: string) => string
  readonly toolCall: (tool: string, args: string) => string
  readonly status: (frame: string, label: string) => string
  /** A lane's tag, in the lane's own colour (`index` picks it). */
  readonly lane: (index: number, text: string) => string
}

const laneColours = [Ansi.cyan, Ansi.yellow, Ansi.blue, Ansi.greenBold, Ansi.magenta]

export const makeTerminalPalette = (enabled: boolean): TerminalPalette => {
  const paint = (code: string, text: string): string =>
    enabled ? `${code}${text}${Ansi.reset}` : text
  return {
    enabled,
    stageStart: (label) => `${paint(Ansi.boldMagenta, "▶ ")}${label}`,
    stageDone: (label) => `${paint(Ansi.green, "✔ ")}${label}`,
    fail: (label) => `${paint(Ansi.red, "✖ ")}${label}`,
    warn: (label) => `${paint(Ansi.yellowBold, "▲ ")}${label}`,
    info: (label) => paint(Ansi.darkGray, `· ${label}`),
    dim: (text) => paint(Ansi.darkGray, text),
    assistant: (text) => `${paint(Ansi.boldMagenta, "● ")}${text}`,
    toolCall: (tool, args) => {
      const head = paint(Ansi.yellowBold, `● ${tool}`)
      return args.length === 0 ? head : `${head} ${paint(Ansi.darkGray, `(${args})`)}`
    },
    status: (frame, label) => `${paint(Ansi.boldMagenta, frame)} ${label}`,
    lane: (index, text) => paint(laneColours[index % laneColours.length] ?? Ansi.cyan, text)
  }
}

export const formatDurationMs = (milliseconds: number): string => {
  if (milliseconds < 1_000) {
    return `${Math.max(0, Math.round(milliseconds))}ms`
  }
  const seconds = milliseconds / 1_000
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`
  }
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return `${minutes}m${rest.toString().padStart(2, "0")}s`
}

export const plainTerminalPalette = makeTerminalPalette(false)

/** Issues listed under a review line at normal verbosity; `--verbose` lists all. */
export const reviewFindingsShown = 5

const severityRank = { Critical: 0, Warning: 1, Info: 2 } as const

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`

/**
 * A review round as the operator reads it: how many issues of each severity
 * and whether the coder is now fixing them, then the most severe ones with
 * where they are.
 */
export const reviewFindingsText = (
  event: ReviewFindings,
  palette: TerminalPalette,
  shown: number
): string => {
  const safe = terminalSafe
  const count = (severity: "Critical" | "Warning" | "Info"): number =>
    event.issues.filter((issue) => issue.severity === severity).length
  const breakdown = [
    [count("Critical"), "critical"],
    [count("Warning"), "warning"],
    [count("Info"), "info"]
  ]
    .filter(([n]) => n !== 0)
    .map(([n, label]) => `${n} ${label}`)
    .join(", ")
  const total = plural(event.issues.length, "issue")
  const head = event.settled
    ? event.issues.length === 0
      ? `review settled after round ${event.round}: clean`
      : `review settled after round ${event.round}: ${total} left (${breakdown})`
    : `review round ${event.round}: ${total} (${breakdown}), fixing`
  const sorted = [...event.issues].sort(
    (left, right) => severityRank[left.severity] - severityRank[right.severity]
  )
  const listed = sorted.slice(0, Math.max(0, shown)).map((issue) => {
    const where =
      issue.file === undefined
        ? ""
        : `${safe(issue.file)}${issue.line === undefined ? "" : `:${issue.line}`} — `
    const title = safe(issue.title).replace(/\s+/g, " ").trim()
    const text = `${where}${title.length > 160 ? `${title.slice(0, 159)}…` : title}`
    return issue.severity === "Critical"
      ? palette.fail(text)
      : issue.severity === "Warning"
        ? palette.warn(text)
        : palette.info(text)
  })
  const rest = sorted.length - listed.length
  return [
    palette.info(head),
    ...listed.map((line) => `  ${line}`),
    ...(rest > 0 ? [`  ${palette.dim(`… ${rest} more (--verbose lists them all)`)}`] : [])
  ].join("\n")
}

export const terminalLine = (
  event: FlowEvent,
  palette: TerminalPalette = plainTerminalPalette,
  verbosity: Verbosity = "Normal"
): string => {
  const safe = terminalSafe
  switch (event._tag) {
    case "ReviewFindings":
      return reviewFindingsText(
        event,
        palette,
        verbosity === "Verbose" || verbosity === "Debug" ? event.issues.length : reviewFindingsShown
      )
    case "JudgmentObserved":
    case "UsageProgress":
      return ""
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
const clearToEnd = "\u001b[J"
const wrapOff = "\u001b[?7l"
const wrapOn = "\u001b[?7h"

export interface TerminalOutput {
  readonly isTTY?: boolean
  readonly columns?: number
  readonly write: (text: string) => unknown
}

/** Cuts a plain status line to the terminal's width, so a wrapped line never breaks the redraw. */
export const fitToWidth = (line: string, columns: number | undefined): string =>
  columns === undefined || columns < 8 || line.length <= columns - 2
    ? line
    : `${line.slice(0, columns - 3)}…`

export const terminalSupportsColor = (
  output: TerminalOutput,
  environment: Readonly<Record<string, string | undefined>>
): boolean => output.isTTY === true && environment.NO_COLOR === undefined

export const makeLiveTerminalSurface = Effect.fn("@llm4ts/runner/Terminal.makeLive")(function* (
  write: (text: string) => void = (text) => {
    process.stdout.write(text)
  },
  palette: TerminalPalette = makeTerminalPalette(true),
  tick: Duration.Input = "100 millis",
  columns: () => number | undefined = () => process.stdout.columns
): Effect.fn.Return<TerminalSurface, never, Scope.Scope> {
  const lock = yield* Semaphore.make(1)
  const status = yield* Ref.make<string | undefined>(undefined)
  const frame = yield* Ref.make(0)
  const suspended = yield* Ref.make(false)
  // How many lines the status block took when last drawn: a multi-line
  // block (one row per concurrent story) is cleared line by line upwards.
  const drawn = yield* Ref.make(0)
  const emit = (text: string): Effect.Effect<void> => Effect.sync(() => write(text))
  // Back to the block's first line, then clear to the end of the screen.
  // Counting on the rows we drew (not on how the terminal wrapped them) is
  // safe because the block is drawn with line wrap off.
  const clearStatus = Effect.flatMap(Ref.getAndSet(drawn, 0), (lines) =>
    emit(lines <= 1 ? `${clearLine}${clearToEnd}` : `\u001b[${lines - 1}A${clearLine}${clearToEnd}`)
  )
  const drawStatus = Effect.gen(function* () {
    if (yield* Ref.get(suspended)) {
      return
    }
    const label = yield* Ref.get(status)
    if (label !== undefined) {
      const currentFrame = yield* Ref.get(frame)
      const width = columns()
      const rows = label.split("\n")
      // Line wrap is off while the block is drawn: a row wider than the
      // terminal (an ambiguous-width character such as "·" counts two
      // columns in some terminals) is clipped instead of wrapping onto a
      // line the next redraw would not clear.
      yield* emit(
        `${wrapOff}${rows
          .map((row, index) =>
            palette.status(
              index === 0 ? (spinnerFrames[currentFrame % spinnerFrames.length] ?? "·") : " ",
              fitToWidth(row, width === undefined ? undefined : width - 2)
            )
          )
          .join("\n")}${wrapOn}`
      )
      yield* Ref.set(drawn, rows.length)
    }
  })
  const surface: TerminalSurface = {
    palette,
    log: (line) =>
      lock.withPermit(
        clearStatus.pipe(Effect.andThen(emit(`${line}\n`)), Effect.andThen(drawStatus))
      ),
    setStatus: (label) =>
      lock.withPermit(
        clearStatus.pipe(Effect.andThen(Ref.set(status, label)), Effect.andThen(drawStatus))
      ),
    suspend: (effect) =>
      lock
        .withPermit(Ref.set(suspended, true).pipe(Effect.andThen(clearStatus)))
        .pipe(
          Effect.andThen(effect),
          Effect.ensuring(
            lock.withPermit(Ref.set(suspended, false).pipe(Effect.andThen(drawStatus)))
          )
        )
  }
  yield* Effect.sleep(tick).pipe(
    Effect.andThen(Ref.update(frame, (current) => current + 1)),
    Effect.andThen(lock.withPermit(clearStatus.pipe(Effect.andThen(drawStatus)))),
    Effect.forever,
    Effect.forkScoped
  )
  yield* Effect.addFinalizer(() => lock.withPermit(clearStatus))
  return surface
})

const hideCursor = "\u001b[?25l"
const showCursor = "\u001b[?25h"

/**
 * While the live status block is on screen, keystrokes must not be echoed:
 * an arrow key (or a trackpad scroll the terminal turns into one) echoes as
 * `^[[A` at the cursor, which sits at the end of the last status row, wraps
 * onto a new line, and leaves the row behind as a stale copy. Echo goes off
 * (Ctrl-C still interrupts: only echo changes) and the cursor is hidden;
 * both come back when the surface closes or the process exits.
 */
const quietTerminalInput = (
  write: (text: string) => void
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const input = process.stdin
    const stty = (setting: string): void => {
      if (process.platform !== "win32" && input.isTTY === true) {
        spawnSync("stty", [setting], { stdio: ["inherit", "ignore", "ignore"] })
      }
    }
    let restored = false
    const restore = (): void => {
      if (!restored) {
        restored = true
        stty("echo")
        write(showCursor)
      }
    }
    // A signal kills the process without an "exit" event: restore first,
    // then let the signal do what it would have done.
    const onSignal = (signal: NodeJS.Signals): void => {
      restore()
      process.kill(process.pid, signal)
    }
    yield* Effect.sync(() => {
      stty("-echo")
      write(hideCursor)
      process.once("exit", restore)
      process.once("SIGINT", onSignal)
      process.once("SIGTERM", onSignal)
    })
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        process.off("exit", restore)
        process.off("SIGINT", onSignal)
        process.off("SIGTERM", onSignal)
        restore()
      })
    )
  })

export const makeTerminalSurface = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
  output: TerminalOutput = process.stdout
): Effect.Effect<TerminalSurface, never, Scope.Scope> => {
  const write = (text: string): void => {
    output.write(text)
  }
  return terminalSupportsColor(output, environment)
    ? Effect.andThen(
        quietTerminalInput(write),
        makeLiveTerminalSurface(
          write,
          makeTerminalPalette(true),
          "100 millis",
          () => output.columns
        )
      )
    : Effect.succeed(makePlainTerminalSurface((line) => write(`${line}\n`)))
}

export interface TerminalRunStats {
  readonly stagesCompleted: number
  readonly stagesFailed: number
}

export interface TerminalConsumer {
  readonly consumed: Ref.Ref<number>
  readonly stats: Effect.Effect<TerminalRunStats>
  readonly awaitDrained: (timeout?: Duration.Input) => Effect.Effect<void>
}

export interface TerminalConsumerOptions {
  readonly timestamps?: boolean
}

interface OpenStage {
  readonly name: string
  readonly startedAt: number
}

/** The lane an event belongs to (a concurrent story), if it carries one. */
export const laneOfEvent = (
  event: FlowEvent
): { readonly lane: string; readonly executor?: string } | undefined => {
  switch (event._tag) {
    case "StageStarted":
    case "StageCompleted":
    case "StageFailed":
    case "Info":
    case "ToolUse":
    case "AssistantMessage":
    case "TokensUsed":
    case "UsageProgress":
    case "ReviewFindings":
      return event.lane === undefined
        ? undefined
        : {
            lane: event.lane,
            ...(event.executor === undefined ? {} : { executor: event.executor })
          }
    default:
      return undefined
  }
}

/** `bonifici-list · lemonade-deepseek` — how a lane is named on screen. */
export const laneLabel = (lane: string, executor: string | undefined): string =>
  executor === undefined ? lane : `${lane} · ${executor}`

/**
 * Whether a laned event is printed as its own line. With several stories
 * running, tool calls are counted on each story's status row instead;
 * `Verbose` prints them all, tagged.
 */
export const rendersLanedEvent = (verbosity: Verbosity, event: FlowEvent): boolean =>
  event._tag === "ToolUse"
    ? verbosity === "Verbose" || verbosity === "Debug"
    : rendersEvent(verbosity, event)

interface LaneState {
  readonly index: number
  depth: number
  stages: ReadonlyArray<OpenStage>
  tools: number
  executor: string | undefined
  readonly startedAt: number
  readonly tokens: TokenTally
  readonly inFlight: Map<string, TokenTally>
  lastTool: { readonly tool: string; readonly at: number } | undefined
}

/** Tokens in and out so far; `estimated` once any report was an estimate. */
export interface TokenTally {
  input: number
  output: number
  estimated: boolean
}

const emptyTally = (): TokenTally => ({ input: 0, output: 0, estimated: false })

/** The completed calls' tally plus every call still streaming. */
const withInFlight = (tally: TokenTally, inFlight: ReadonlyMap<string, TokenTally>): TokenTally => {
  let input = tally.input
  let output = tally.output
  for (const call of inFlight.values()) {
    input += call.input
    output += call.output
  }
  return { input, output, estimated: tally.estimated }
}

/** A progress event's effect on the calls in flight. */
const trackProgress = (inFlight: Map<string, TokenTally>, event: FlowEvent): void => {
  if (event._tag !== "UsageProgress") {
    return
  }
  if (event.done === true || event.usage === undefined) {
    inFlight.delete(event.call)
    return
  }
  inFlight.set(event.call, {
    input: event.usage.prompt,
    output: event.usage.completion,
    estimated: false
  })
}

const addTokens = (tally: TokenTally, event: FlowEvent): void => {
  if (event._tag !== "TokensUsed") {
    return
  }
  tally.input += event.usage.prompt
  tally.output += event.usage.completion
  if (event.model?.startsWith("estimated:") === true) {
    tally.estimated = true
  }
}

/** 950 → "950", 12_400 → "12.4k", 1_250_000 → "1.3M". */
export const formatCount = (value: number): string =>
  value < 1_000
    ? `${Math.max(0, Math.round(value))}`
    : value < 1_000_000
      ? `${(value / 1_000).toFixed(1)}k`
      : `${(value / 1_000_000).toFixed(1)}M`

/** `3.5k tokens` (in and out together), `~` when estimated; empty before any report. */
export const formatTally = (tally: TokenTally | undefined): string => {
  if (tally === undefined || (tally.input === 0 && tally.output === 0)) {
    return ""
  }
  return `${tally.estimated ? "~" : ""}${formatCount(tally.input + tally.output)} tokens`
}

/** How long after a tool call a lane still reads as "Running <tool>…". */
export const toolActivityWindowMs = 15_000

/** What a lane is doing right now, in two words. */
export const activityOf = (
  lastTool: { readonly tool: string; readonly at: number } | undefined,
  now: number
): string =>
  lastTool !== undefined && now - lastTool.at <= toolActivityWindowMs
    ? `Running ${lastTool.tool}…`
    : "Thinking…"

/** One status row per active lane, the run's own stage (if any) first. */
export const statusBlock = (
  globalStage: string | undefined,
  lanes: ReadonlyArray<{
    readonly lane: string
    readonly executor: string | undefined
    readonly stage: string | undefined
    readonly elapsedMs: number
    readonly tools: number
    readonly tokens?: TokenTally
    readonly activity?: string
  }>,
  globalTokens?: TokenTally
): string | undefined => {
  // Time, tokens and what it is doing first — the stage title last, so a
  // narrow terminal cuts the title, not the signs of life.
  const rows = lanes
    .filter((lane) => lane.stage !== undefined)
    .map((lane) =>
      [
        laneLabel(lane.lane, lane.executor),
        formatDurationMs(lane.elapsedMs),
        formatTally(lane.tokens),
        lane.activity ?? "",
        lane.stage ?? ""
      ]
        .filter((part) => part.length > 0)
        .join(" · ")
    )
  const tally = formatTally(globalTokens)
  const head =
    globalStage === undefined
      ? []
      : [tally.length === 0 ? globalStage : `${globalStage} · ${tally}`]
  const block = [...head, ...rows]
  return block.length === 0 ? undefined : block.join("\n")
}

export const consumeTerminalEvents = Effect.fn("@llm4ts/runner/Terminal.consume")(function* (
  events: FlowEventHub,
  surface: TerminalSurface,
  verbosity: Verbosity = "Normal",
  options: TerminalConsumerOptions = {}
): Effect.fn.Return<TerminalConsumer, never, Scope.Scope> {
  const depth = yield* Ref.make(0)
  const stages = yield* Ref.make<ReadonlyArray<OpenStage>>([])
  // Concurrent stories keep their own stage stacks: one shared stack
  // interleaves their stages, closes the wrong one, and shows whichever
  // story started last as the only thing running.
  const lanes = new Map<string, LaneState>()
  // Tokens of events outside any lane: the whole run, for a flow with one coder.
  const runTokens = emptyTally()
  const runInFlight = new Map<string, TokenTally>()
  const consumed = yield* Ref.make(0)
  const statsRef = yield* Ref.make<TerminalRunStats>({ stagesCompleted: 0, stagesFailed: 0 })
  const subscription = yield* events.subscribe
  const palette = surface.palette
  const timestampPrefix =
    options.timestamps === true
      ? Clock.currentTimeMillis.pipe(
          Effect.map((now) => `${palette.dim(new Date(now).toISOString().slice(11, 19))} `)
        )
      : Effect.succeed("")

  const refreshStatus = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const global = (yield* Ref.get(stages)).at(-1)?.name
    yield* surface.setStatus(
      statusBlock(
        global,
        [...lanes.entries()].map(([lane, state]) => ({
          lane,
          executor: state.executor,
          stage: state.stages.at(-1)?.name,
          elapsedMs: now - state.startedAt,
          tools: state.tools,
          tokens: withInFlight(state.tokens, state.inFlight),
          activity: activityOf(state.lastTool, now)
        })),
        withInFlight(runTokens, runInFlight)
      )
    )
  })

  const countStage = (event: FlowEvent): Effect.Effect<void> =>
    event._tag === "StageCompleted"
      ? Ref.update(statsRef, (current) => ({
          ...current,
          stagesCompleted: current.stagesCompleted + 1
        }))
      : event._tag === "StageFailed"
        ? Ref.update(statsRef, (current) => ({
            ...current,
            stagesFailed: current.stagesFailed + 1
          }))
        : Effect.void

  const withDuration = (event: FlowEvent, line: string, closed: OpenStage | undefined) =>
    Effect.gen(function* () {
      if (
        closed === undefined ||
        (event._tag !== "StageCompleted" && event._tag !== "StageFailed")
      ) {
        return line
      }
      const now = yield* Clock.currentTimeMillis
      return `${line} ${palette.dim(`(${formatDurationMs(now - closed.startedAt)})`)}`
    })

  yield* Stream.fromSubscription(subscription).pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        const tagged = laneOfEvent(event)
        if (tagged !== undefined && event._tag === "UsageProgress" && !lanes.has(tagged.lane)) {
          // A call that ends after its story's row closed: nothing to show.
          yield* Ref.update(consumed, (count) => count + 1)
          return
        }
        if (tagged !== undefined) {
          const now = yield* Clock.currentTimeMillis
          const state =
            lanes.get(tagged.lane) ??
            ({
              index: lanes.size,
              depth: 0,
              stages: [],
              tools: 0,
              executor: undefined,
              startedAt: now,
              tokens: emptyTally(),
              inFlight: new Map(),
              lastTool: undefined
            } satisfies LaneState)
          lanes.set(tagged.lane, state)
          if (tagged.executor !== undefined) {
            state.executor = tagged.executor
          }
          let closed: OpenStage | undefined
          if (closesChild(event)) {
            state.depth = Math.max(0, state.depth - 1)
          }
          const lineDepth = state.depth
          if (event._tag === "StageStarted") {
            state.depth += 1
            state.stages = [...state.stages, { name: terminalSafe(event.stage), startedAt: now }]
          } else if (closesChild(event)) {
            closed = state.stages.at(-1)
            state.stages = state.stages.slice(0, -1)
            yield* countStage(event)
          } else if (event._tag === "ToolUse") {
            state.tools += 1
            state.lastTool = { tool: terminalSafe(event.tool), at: now }
          }
          addTokens(state.tokens, event)
          trackProgress(state.inFlight, event)
          if (state.stages.length === 0 && closesChild(event)) {
            lanes.delete(tagged.lane)
          }
          if (rendersLanedEvent(verbosity, event)) {
            const tag = palette.lane(state.index, `[${laneLabel(tagged.lane, state.executor)}]`)
            const line = yield* withDuration(event, terminalLine(event, palette, verbosity), closed)
            const prefix = yield* timestampPrefix
            yield* surface.log(`${prefix}${tag} ${indentBlock(lineDepth, line)}`)
          }
          yield* refreshStatus
          yield* Ref.update(consumed, (count) => count + 1)
          return
        }
        if (event._tag === "TokensUsed" || event._tag === "UsageProgress") {
          addTokens(runTokens, event)
          trackProgress(runInFlight, event)
          yield* refreshStatus
        }
        const currentDepth = closesChild(event)
          ? yield* Ref.updateAndGet(depth, (value) => Math.max(0, value - 1))
          : yield* Ref.get(depth)
        let closedStage: OpenStage | undefined
        if (event._tag === "StageStarted") {
          yield* Ref.update(depth, (value) => value + 1)
          const active = terminalSafe(event.stage)
          const startedAt = yield* Clock.currentTimeMillis
          yield* Ref.update(stages, (current) => [...current, { name: active, startedAt }])
          yield* refreshStatus
        } else if (closesChild(event)) {
          closedStage = (yield* Ref.get(stages)).at(-1)
          yield* Ref.update(stages, (current) => current.slice(0, -1))
          yield* refreshStatus
          yield* countStage(event)
        }
        if (rendersEvent(verbosity, event)) {
          const line = yield* withDuration(
            event,
            terminalLine(event, palette, verbosity),
            closedStage
          )
          const prefix = yield* timestampPrefix
          yield* surface.log(`${prefix}${indentBlock(currentDepth, line)}`)
        }
        yield* Ref.update(consumed, (count) => count + 1)
      })
    ),
    Effect.forkScoped
  )
  // Elapsed time and "Running <tool>…" age between events too.
  yield* Effect.sleep("1 second").pipe(
    Effect.andThen(Effect.suspend(() => (lanes.size === 0 ? Effect.void : refreshStatus))),
    Effect.forever,
    Effect.forkScoped
  )
  // Display only, so a drain that gives up just means a trailing line was
  // never printed; the shared helper already bounds the wait.
  const awaitDrained = (timeout?: Duration.Input): Effect.Effect<void> =>
    Effect.asVoid(awaitConsumed(events, consumed, timeout))
  return { consumed, stats: Ref.get(statsRef), awaitDrained }
})
