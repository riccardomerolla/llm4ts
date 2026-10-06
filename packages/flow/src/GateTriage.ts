// Gates with a memory (ADR 0027): what the target's gates said on the code a
// change started from, and which failing lines the change can be charged
// with. Pure helpers and a small store; the seams are lintCommand and
// reviewAndFixLoop (Review.ts), implementPlanFlow (Flow.ts) and the story
// executor (Stories.ts). Gates.ts re-exports this module beside gatesIn.
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { PersistenceError } from "./FlowError.ts"
import type { PlainFileStoreShape } from "./Persistence.ts"
import { ReviewIssue, ReviewResult } from "./Review.ts"
import { fingerprintOf } from "./ReviewCache.ts"

export const GateClass = Schema.Literals(["red", "hang", "crash"])
export type GateClass = typeof GateClass.Type

export const FailureOrigin = Schema.Literals(["new", "base", "flaky"])
export type FailureOrigin = typeof FailureOrigin.Type

export class GateBaseline extends Schema.Class<GateBaseline>("GateBaseline")({
  baseCommit: Schema.String,
  appDir: Schema.String,
  /** Each gate command as configured, joined with one space. */
  commands: Schema.Array(Schema.String),
  failingLines: Schema.Array(Schema.String),
  recordedAt: Schema.Number
}) {}

/** Every baseline a run recorded, by `baselineKey`; one file, deleted on land. */
const Baselines = Schema.Record(Schema.String, GateBaseline)
const BaselinesJson = Schema.fromJsonString(Baselines)
const decodeBaselines = Schema.decodeUnknownEffect(BaselinesJson)
const encodeBaselines = Schema.encodeSync(BaselinesJson)

// Built from the escape code point so the pattern holds no control character literal.
const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu")
const duration = /\b\d+(?:\.\d+)?\s?(?:ms|s|m)\b/gu
const isoTimestamp = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?/gu
const stackFrame = /^\s*at\s/u
const summaryLine =
  /^\s*(?:Test Files|Tests|Duration|Start at|Snapshots|Found \d+ errors?|\d+ (?:passing|failing|pending))\b/u
const failureMarker =
  /FAIL|✗|×|✘|✖|❯|error|Error|AssertionError|Expected|Received|expected|TS\d{4}/u

/**
 * The lines of a gate's output a change can be blamed for, made comparable
 * across runs and worktrees: colours, timings, timestamps and the given root
 * prefixes removed; stack frames, summaries and blank lines dropped; only
 * lines carrying a failure marker kept, each once. A heuristic by design:
 * per-tool parsers are kit material (a pack `diagnostics:` command, later).
 */
export const normalizeGateOutput = (
  text: string,
  roots: ReadonlyArray<string>
): ReadonlyArray<string> => {
  const prefixes = roots.filter((root) => root.length > 0).map((root) => root.replace(/\/+$/u, ""))
  const seen = new Set<string>()
  const out: Array<string> = []
  for (const raw of text.split(/\r?\n/u)) {
    let line = raw.replace(ansi, "")
    for (const prefix of prefixes) {
      line = line.replaceAll(`${prefix}/`, "")
    }
    line = line.replace(isoTimestamp, "<ts>").replace(duration, "<t>").trim()
    if (line.length === 0 || stackFrame.test(line) || summaryLine.test(line)) {
      continue
    }
    if (!failureMarker.test(line)) {
      continue
    }
    line = line.replace(/\s+/gu, " ")
    if (!seen.has(line)) {
      seen.add(line)
      out.push(line)
    }
  }
  return out
}

/** The title prefix `lintCommand` gives every gate issue; nothing else is a gate. */
export const gateIssuePrefix = "lint failed: "

export const isGateIssue = (issue: ReviewIssue): boolean => issue.title.startsWith(gateIssuePrefix)

/** Every gate issue's normalized failing lines, in order, each once. */
export const failingLinesOf = (
  result: ReviewResult,
  roots: ReadonlyArray<string>
): ReadonlyArray<string> =>
  Array.from(
    new Set(
      result.issues
        .filter(isGateIssue)
        .flatMap((issue) => normalizeGateOutput(issue.description, roots))
    )
  )

export interface GateTriage {
  /** The lint result with only the failures the change caused; clean when it caused none. */
  readonly blocking: ReviewResult
  readonly newLines: ReadonlyArray<string>
  /** Failing lines already red on the base: listed, never charged. */
  readonly inherited: ReadonlyArray<string>
}

/**
 * Splits a lint result against the baseline. A gate issue whose every
 * failing line is on the baseline is dropped (inherited); one with new lines
 * is kept with `origin: "new"` and its description reduced to those lines,
 * so the fix prompt names only what the change broke. A gate issue with no
 * recognizable failing line at all (a hang, a crash, an unparsed output) is
 * kept whole. Non-gate issues (the perimeter, the oracle guard) pass through.
 * Without a baseline the result is returned as is.
 */
export const triageGates = (
  result: ReviewResult,
  baseline: GateBaseline | undefined,
  roots: ReadonlyArray<string>
): GateTriage => {
  if (baseline === undefined || result.isClean) {
    return { blocking: result, newLines: [], inherited: [] }
  }
  const known = new Set(baseline.failingLines)
  const newLines: Array<string> = []
  const inherited: Array<string> = []
  const issues: Array<ReviewIssue> = []
  for (const issue of result.issues) {
    if (!isGateIssue(issue)) {
      issues.push(issue)
      continue
    }
    const lines = normalizeGateOutput(issue.description, roots)
    const fresh = lines.filter((line) => !known.has(line))
    inherited.push(...lines.filter((line) => known.has(line)))
    if (lines.length > 0 && fresh.length === 0) {
      continue
    }
    newLines.push(...fresh)
    issues.push(
      ReviewIssue.make({
        ...issue,
        origin: "new",
        description: fresh.length > 0 ? fresh.join("\n") : issue.description
      })
    )
  }
  return {
    blocking: ReviewResult.make({
      issues,
      summary: issues.length === 0 ? "lint passed (inherited failures only)" : result.summary
    }),
    newLines: Array.from(new Set(newLines)),
    inherited: Array.from(new Set(inherited))
  }
}

export const baselineKey = (parts: {
  readonly baseCommit: string
  readonly appDir: string
  readonly commands: ReadonlyArray<ReadonlyArray<string>>
}): string =>
  fingerprintOf([
    parts.baseCommit,
    parts.appDir,
    ...parts.commands.map((command) => command.join(" "))
  ]).slice(0, 16)

/** The one file a run keeps its baselines in. */
export const baselinesPath = (stateDir: string): string =>
  `${stateDir.replace(/\/+$/u, "")}/gates/baselines.json`

const readAll = (
  files: PlainFileStoreShape,
  path: string
): Effect.Effect<Readonly<Record<string, GateBaseline>>, PersistenceError> =>
  files.read(path).pipe(
    Effect.flatMap((text) =>
      text === undefined
        ? Effect.succeed({})
        : decodeBaselines(text).pipe(
            // An unreadable file is no baseline: the caller records a fresh one.
            Effect.catch(() => Effect.succeed({}))
          )
    )
  )

export const readBaseline = (
  files: PlainFileStoreShape,
  stateDir: string,
  key: string
): Effect.Effect<GateBaseline | undefined, PersistenceError> =>
  Effect.map(readAll(files, baselinesPath(stateDir)), (all) => all[key])

export interface EnsureBaselineArgs<E> {
  readonly files: PlainFileStoreShape
  readonly stateDir: string
  /** The commit the change starts from. */
  readonly commit: string
  readonly appDir: string
  readonly commands: ReadonlyArray<ReadonlyArray<string>>
  /** Runs the gates on that commit; called only when no baseline is stored. */
  readonly run: Effect.Effect<ReviewResult, E>
  /** Root prefixes stripped from gate output (the work dir, the app dir). */
  readonly roots: ReadonlyArray<string>
  readonly now: Effect.Effect<number>
}

/**
 * The baseline for a commit: the stored one, or a fresh one recorded from
 * `run`. Lazy on purpose, so a second change on an unchanged commit costs
 * no gate run.
 */
export const ensureBaseline = <E>(
  args: EnsureBaselineArgs<E>
): Effect.Effect<GateBaseline, E | PersistenceError> =>
  Effect.gen(function* () {
    const key = baselineKey({
      baseCommit: args.commit,
      appDir: args.appDir,
      commands: args.commands
    })
    const stored = yield* readBaseline(args.files, args.stateDir, key)
    if (stored !== undefined) {
      return stored
    }
    const result = yield* args.run
    const baseline = GateBaseline.make({
      baseCommit: args.commit,
      appDir: args.appDir,
      commands: args.commands.map((command) => command.join(" ")),
      failingLines: failingLinesOf(result, args.roots),
      recordedAt: yield* args.now
    })
    yield* writeBaseline(args.files, args.stateDir, key, baseline)
    return baseline
  })

export const writeBaseline = (
  files: PlainFileStoreShape,
  stateDir: string,
  key: string,
  baseline: GateBaseline
): Effect.Effect<void, PersistenceError> => {
  const path = baselinesPath(stateDir)
  return Effect.flatMap(readAll(files, path), (all) =>
    files.writeAtomic(path, encodeBaselines({ ...all, [key]: baseline }))
  )
}
