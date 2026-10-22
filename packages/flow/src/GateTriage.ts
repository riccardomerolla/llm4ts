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

/**
 * Why a test gate's exit code proves nothing: the runner collected or ran
 * zero tests, or test files failed to load (an import that no longer
 * resolves, a suite that errors before its first test). Either makes the
 * gate red whatever the runner's exit code was.
 */
export const GateReason = Schema.Literals(["zero-tests", "load-failure"])
export type GateReason = typeof GateReason.Type

// One suite that errored before its tests ran, per runner: Vitest's
// "Failed Suites", Jest's "Test suite failed to run", pytest's collection
// errors, JUnit's class initialisation error under Surefire.
const loadFailureMarkers: ReadonlyArray<RegExp> = [
  /Failed Suites\s+\d+/u,
  /Test suite failed to run/u,
  /\berrors? during collection\b/u,
  /ExceptionInInitializerError|initializationError/u
]
const vitestNoTests = /\bTests\s+no tests\b/u
const vitestFilesFailed = /\bTest Files\s+\d+ failed\b/u
// Nothing collected: Vitest, Jest, pytest, Surefire, Gradle.
const zeroTestsMarkers: ReadonlyArray<RegExp> = [
  /No test files found/u,
  vitestNoTests,
  /No tests found, exiting with code/u,
  /\bTests:\s+0 total\b/u,
  /\bno tests ran\b/u,
  /\bcollected 0 items\b/u,
  /No tests to run\./u,
  /No tests found for given includes/u
]
const cargoRunning = /\brunning (\d+) tests?\b/gu
const junitRun = /\bTests run:\s*(\d+)/gu
const mochaPassing = /^\s*0 passing\b/mu
const mochaFailing = /^\s*\d+ failing\b/mu

const everyCountZero = (pattern: RegExp, output: string): boolean => {
  let seen = false
  pattern.lastIndex = 0
  for (let match = pattern.exec(output); match !== null; match = pattern.exec(output)) {
    seen = true
    if (Number.parseInt(match[1] ?? "0", 10) > 0) {
      return false
    }
  }
  return seen
}

/**
 * The reason a test runner's output cannot stand for a green gate, when
 * it has one: `load-failure` when any suite errored before its tests ran
 * (it wins, since a load failure also leaves tests unrun), `zero-tests`
 * when the runner collected nothing (Vitest, Jest, pytest, cargo test,
 * mocha, JUnit via Maven or Gradle). `undefined` means tests ran.
 */
export const testGateReasonOf = (output: string): GateReason | undefined => {
  if (loadFailureMarkers.some((pattern) => pattern.test(output))) {
    return "load-failure"
  }
  if (vitestNoTests.test(output) && vitestFilesFailed.test(output)) {
    return "load-failure"
  }
  if (zeroTestsMarkers.some((pattern) => pattern.test(output))) {
    return "zero-tests"
  }
  if (everyCountZero(cargoRunning, output) || everyCountZero(junitRun, output)) {
    return "zero-tests"
  }
  if (mochaPassing.test(output) && !mochaFailing.test(output)) {
    return "zero-tests"
  }
  return undefined
}

/** The reason as the fix prompt and the findings read it. */
export const describeGateReason = (reason: GateReason): string =>
  reason === "zero-tests"
    ? "test gate ran zero tests (zero-tests): the runner collected no test, so its exit code proves nothing"
    : "test files failed to load (load-failure): a suite errored before its tests ran, so the gate is red whatever its exit code"

/**
 * The reason as a failing line, so a baseline records it and triage
 * compares it like any other line: a target whose base already ran zero
 * tests inherits that, a change that breaks loading is charged with it.
 */
export const gateReasonLine = (reason: GateReason): string => `gate reason: ${reason}`

/** The first gate reason a result carries, if any. */
export const gateReasonOf = (result: ReviewResult): GateReason | undefined =>
  result.issues.find((issue) => isGateIssue(issue) && issue.gateReason !== undefined)?.gateReason

export class GateBaseline extends Schema.Class<GateBaseline>("GateBaseline")({
  baseCommit: Schema.String,
  appDir: Schema.String,
  /** Each gate command as configured, joined with one space. */
  commands: Schema.Array(Schema.String),
  failingLines: Schema.Array(Schema.String),
  /** Tests passing on the base, when the test gate's output said (the oracle guard compares). */
  passedCount: Schema.optionalKey(Schema.Int),
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
export const gateIssuePrefix = "gate failed: "

/** What gate issues were titled before every gate, not only lint, was named for what it is. */
const legacyGateIssuePrefix = "lint failed: "

export const isGateIssue = (issue: ReviewIssue): boolean =>
  issue.title.startsWith(gateIssuePrefix) || issue.title.startsWith(legacyGateIssuePrefix)

/** A gate issue's comparable lines: its reason first, then its normalized output. */
const failingLinesOfIssue = (
  issue: ReviewIssue,
  roots: ReadonlyArray<string>
): ReadonlyArray<string> => [
  ...(issue.gateReason === undefined ? [] : [gateReasonLine(issue.gateReason)]),
  ...normalizeGateOutput(issue.description, roots)
]

/** Every gate issue's normalized failing lines, in order, each once. */
export const failingLinesOf = (
  result: ReviewResult,
  roots: ReadonlyArray<string>
): ReadonlyArray<string> =>
  Array.from(
    new Set(result.issues.filter(isGateIssue).flatMap((issue) => failingLinesOfIssue(issue, roots)))
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
    const lines = failingLinesOfIssue(issue, roots)
    const fresh = lines.filter((line) => !known.has(line))
    inherited.push(...lines.filter((line) => known.has(line)))
    if (lines.length > 0 && fresh.length === 0) {
      continue
    }
    newLines.push(...fresh)
    // A fresh reason keeps its sentence, so the fix prompt says what the
    // runner's output meant, not only which lines were new.
    const reasonLine = issue.gateReason === undefined ? undefined : gateReasonLine(issue.gateReason)
    const freshOutput = fresh.filter((line) => line !== reasonLine)
    const description =
      issue.gateReason !== undefined && fresh.includes(reasonLine ?? "")
        ? [describeGateReason(issue.gateReason), ...freshOutput].join("\n")
        : fresh.length > 0
          ? fresh.join("\n")
          : issue.description
    issues.push(
      ReviewIssue.make({
        ...issue,
        origin: "new",
        description
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
      ...(result.passed === undefined ? {} : { passedCount: result.passed }),
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
