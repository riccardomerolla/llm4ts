import { join } from "node:path"
import * as Clock from "effect/Clock"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import type { LlmError } from "@llm4ts/core/Errors"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import type { JsonSchema } from "@llm4ts/core/Models"
import type { ProcessExecutorShape, ProcessResult } from "@llm4ts/core/ProcessExecutor"
import { Capabilities } from "@llm4ts/core/Capability"
import { guarded } from "./CapabilityGuard.ts"
import type { Chat } from "./Chat.ts"
import {
  FlowLlmError,
  ProcessError,
  Stalled,
  describeFlowError,
  type FlowError
} from "./FlowError.ts"
import type { PlainFileStoreShape } from "./Persistence.ts"
import { GateBaseline, isGateIssue, triageGates } from "./GateTriage.ts"
import {
  type OracleRules,
  checkOracle,
  defaultOracleRules,
  parseUnifiedDiff,
  passedCountIn
} from "./OracleGuard.ts"
import { cachedReview, fingerprintOf } from "./ReviewCache.ts"
import {
  ReviewFindingDemoted,
  Info,
  JudgmentObserved,
  ReviewFinding,
  ReviewFindings,
  publishJudgmentObserved,
  Timed,
  type FlowEventsShape
} from "./FlowEvents.ts"
import { attr, withKindSpan } from "./Spans.ts"
import { Reviewer, parseReviewer } from "./Reviewer.ts"
import { publishUsage } from "./Usage.ts"
import type { JudgmentShape } from "@llm4ts/core/judgment/Judgment"
import { truth, type JudgmentResult, type TruthAnswer } from "@llm4ts/core/judgment/Schemas"
import {
  certaintyOf,
  decide,
  defaultJudgmentPolicy,
  type Decision,
  type JudgmentMode,
  type JudgmentPolicy
} from "./Judgment.ts"

export const Severity = Schema.Literals(["Critical", "Warning", "Info"])
export type Severity = typeof Severity.Type

export class ReviewIssue extends Schema.Class<ReviewIssue>("ReviewIssue")({
  severity: Severity,
  title: Schema.String,
  description: Schema.String.pipe(
    Schema.withConstructorDefault(Effect.succeed("")),
    Schema.withDecodingDefaultKey(Effect.succeed(""))
  ),
  file: Schema.optionalKey(Schema.String),
  line: Schema.optionalKey(Schema.Int),
  suggestion: Schema.optionalKey(Schema.String),
  confidence: Schema.Number.pipe(
    Schema.withConstructorDefault(Effect.succeed(1)),
    Schema.withDecodingDefaultKey(Effect.succeed(1))
  ),
  /** A gate failure's triage against the base (ADR 0027); absent for review findings. */
  origin: Schema.optionalKey(Schema.Literals(["new", "base", "flaky"])),
  /** How a gate ended: a red exit, killed at the timeout, or a signal exit. */
  gateClass: Schema.optionalKey(Schema.Literals(["red", "hang", "crash"])),
  /** Where the gate's full output was written, when the caller asked for a log. */
  logPath: Schema.optionalKey(Schema.String)
}) {}

export class ReviewResult extends Schema.Class<ReviewResult>("ReviewResult")({
  issues: Schema.Array(ReviewIssue),
  summary: Schema.String.pipe(
    Schema.withConstructorDefault(Effect.succeed("")),
    Schema.withDecodingDefaultKey(Effect.succeed(""))
  ),
  /** A test gate's passed-test count, when its output had a summary the oracle guard reads (ADR 0027). */
  passed: Schema.optionalKey(Schema.Int)
}) {
  get isClean(): boolean {
    return this.issues.length === 0
  }
}

export const reviewJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["Critical", "Warning", "Info"] },
          title: { type: "string" },
          description: { type: "string" },
          file: { type: "string" },
          line: { type: "integer" },
          suggestion: { type: "string" },
          confidence: { type: "number" }
        },
        required: ["severity", "title", "description"]
      }
    },
    summary: { type: "string" }
  },
  required: ["issues", "summary"]
}

const reviewer = (name: string, systemPrompt: string, screen: string, files = ".*"): Reviewer =>
  Reviewer.make({ name, systemPrompt, files, screen })

/**
 * Rules with teeth (ADR 0027 decision 9), in front of every lens and the
 * judge rubric: what no reviewer accepts whatever its concern. A pack's
 * `## Review rules` extends it; `preamble: off` leaves it out.
 */
export const reviewRulesPreamble = [
  "Rules every reviewer applies, whatever its concern:",
  "- A stubbed body, a placeholder return, a TODO where logic belongs, or a function that only",
  "  satisfies the type checker is a Critical finding.",
  "- A skipped, deleted, weakened or hard-coded test is a Critical finding.",
  "- A layering workaround (a runtime hook where a signature should change, a cast or `any`",
  "  to silence a type, a duplicated type to avoid an import) is a Critical finding.",
  "- If the change needs a paragraph-long comment to justify why a workaround is acceptable,",
  "  the code is wrong, not the comment; report it."
].join("\n")

/** The one lens whose job is the Bun port's reviewer brief: find why the diff does not work. */
export const adversarialReviewer = reviewer(
  "adversarial",
  [
    "Your only job is to find reasons this change does not work. Assume the code is wrong and",
    "look for the evidence: a path that is never taken, an error that is swallowed, a value that",
    "is wrong at a boundary (empty, zero, negative, unicode, concurrent), a promise or effect that",
    "is never awaited or yielded, a resource that leaks, a test that passes without exercising the",
    "change. The diff is the whole subject. Report every concrete way it fails as a finding with",
    "the file and line; an empty list means you looked and found none, not that it is fine."
  ].join("\n"),
  "The diff plausibly contains a defect an adversarial reader would find: a wrong boundary, an unhandled path, a leaked resource, a test that does not exercise the change."
)

/** The prompt a lens is asked with: the preamble (unless the lens opts out), then its own rules. */
export const lensPrompt = (lens: Reviewer): string =>
  lens.preamble === false ? lens.systemPrompt : `${reviewRulesPreamble}\n\n${lens.systemPrompt}`

export const correctnessReviewer = reviewer(
  "code-functionality",
  [
    "Review for functional correctness. Check that the change implements the task's intent,",
    "handles obvious edge cases, and does not regress existing behavior. Report only concrete",
    "logic errors, wrong conditions, mishandled error paths, and missing cases. Ignore style."
  ].join("\n"),
  "The diff plausibly contains a logic error, a wrong condition, a mishandled error path, or a missing case."
)

export const readabilityReviewer = reviewer(
  "readability",
  [
    "Review for readability and clarity. Check names, focused functions, understandable control",
    "flow, and useful comments. Report only concrete, actionable readability problems."
  ].join("\n"),
  "The diff plausibly introduces an unclear name, a tangled function, or confusing control flow."
)

export const testReviewer = reviewer(
  "test",
  [
    "Review test coverage and quality. Check that new behavior and important error paths are",
    "covered by tests that assert real outcomes and would fail on regression. Report concrete gaps."
  ].join("\n"),
  "The diff changes behavior that is not covered by a test in the same diff."
)

export const structureReviewer = reviewer(
  "code-structure",
  "Review module boundaries, dependency direction, cohesion, and unnecessary coupling. Report concrete structural problems.",
  "The diff plausibly crosses a module boundary, reverses a dependency direction, or adds coupling."
)

export const performanceReviewer = reviewer(
  "performance",
  "Review for material performance regressions, unbounded work, avoidable repeated I/O, and resource leaks.",
  "The diff plausibly changes performance characteristics: unbounded work, repeated I/O, or a resource leak."
)

export const securityReviewer = reviewer(
  "security",
  "Review trust boundaries, input handling, secrets, authorization, injection risks, and unsafe defaults.",
  "The diff plausibly touches a trust boundary, secret, authorization check, input parser, or unsafe default."
)

export const effectReviewer = reviewer(
  "effect-ts",
  "Review Effect usage: typed errors, scoped resources, service boundaries, interruption, concurrency, and runtime ownership.",
  "The diff plausibly misuses Effect: an untyped error, an unscoped resource, a leaked service, or unmanaged concurrency.",
  ".*\\.(ts|tsx|mts|cts)$"
)

export const minimalReviewers: ReadonlyArray<Reviewer> = Object.freeze([
  adversarialReviewer,
  correctnessReviewer,
  readabilityReviewer,
  testReviewer
])

export const allReviewers: ReadonlyArray<Reviewer> = Object.freeze([
  adversarialReviewer,
  correctnessReviewer,
  testReviewer,
  readabilityReviewer,
  structureReviewer,
  performanceReviewer,
  securityReviewer,
  effectReviewer
])

export interface ReviewerSelector {
  readonly select: (
    reviewers: ReadonlyArray<Reviewer>,
    changedFiles: ReadonlyArray<string>,
    round: number,
    previous: ReviewResult | undefined
  ) => Effect.Effect<ReadonlyArray<Reviewer>, FlowError>
}

export const allEveryRound: ReviewerSelector = {
  select: (reviewers, changedFiles, _round, _previous) =>
    Effect.succeed(reviewers.filter((candidate) => candidate.matches(changedFiles)))
}

export const whileDirty: ReviewerSelector = {
  select: (reviewers, changedFiles, round, previous) =>
    Effect.succeed(
      round === 1 || previous === undefined || !previous.isClean
        ? reviewers.filter((candidate) => candidate.matches(changedFiles))
        : []
    )
}

export class ReviewerPick extends Schema.Class<ReviewerPick>("ReviewerPick")({
  reviewers: Schema.Array(Schema.String)
}) {}

const reviewerPickJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    reviewers: {
      type: "array",
      items: { type: "string" }
    }
  },
  required: ["reviewers"]
}

export const llmDriven = (picker: LlmServiceShape): ReviewerSelector => ({
  select: (reviewers, changedFiles, _round, _previous) => {
    const scoped = reviewers.filter((candidate) => candidate.matches(changedFiles))
    if (scoped.length <= 1 || changedFiles.length === 0) {
      return Effect.succeed(scoped)
    }
    const names = scoped.map((candidate) => candidate.name)
    const prompt = [
      `Pick the reviewers relevant to these files. Available reviewers: ${names.join(", ")}.`,
      "Changed files:",
      ...changedFiles,
      'Respond only with JSON: {"reviewers":["name", ...]}.'
    ].join("\n")
    return picker.executeStructured(prompt, ReviewerPick, reviewerPickJsonSchema).pipe(
      Effect.map((pick) => scoped.filter((candidate) => pick.reviewers.includes(candidate.name))),
      Effect.catch(() => Effect.succeed(scoped)),
      Effect.map((chosen) => (chosen.length === 0 ? scoped : chosen))
    )
  }
})

/** A lens name as a file name. */
const fileSlug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "lens"

export const reviewPrompt = (task: string, diff: string): string =>
  [
    `Review the change below for task "${task}". Report problems as JSON:`,
    '{"issues":[{"severity":"Critical|Warning|Info","title":"...",',
    '"description":"..."}],"summary":"..."}.',
    'An empty "issues" array means the change is acceptable. Respond with JSON only.',
    "The diff below is the whole subject: judge what it shows. Do not explore the",
    "repository, read other files, or run anything; answer from the diff.",
    "",
    "Diff:",
    diff
  ].join("\n")

export interface FixPromptOptions {
  /** Characters of a gate's output kept in the prompt, from the end. Default 4000. */
  readonly tailChars?: number
  /** Name the gate log's path (a CLI coder can open it; an API coder cannot). Default false. */
  readonly showPaths?: boolean
}

export const defaultGateTailChars = 4_000

const evidenceNote =
  "The gate output above is your only runtime evidence. If you are guessing without it, say `confidence: low` in your Findings."

export const fixPrompt = (result: ReviewResult, options: FixPromptOptions = {}): string => {
  const tailChars = options.tailChars ?? defaultGateTailChars
  const lines = result.issues.map((issue) => {
    const gate = isGateIssue(issue)
    const description =
      gate && issue.description.length > tailChars
        ? `…${issue.description.slice(-tailChars)}`
        : issue.description
    const path =
      gate && options.showPaths === true && issue.logPath !== undefined
        ? ` (full output: ${issue.logPath})`
        : ""
    return `- [${issue.severity}] ${issue.title}: ${description}${path}`
  })
  const hasGate = result.issues.some(isGateIssue)
  return [
    "Address these review findings, then stop:",
    ...lines,
    ...(hasGate ? ["", evidenceNote] : [])
  ].join("\n")
}

export interface GateTriageOptions {
  /** The baseline for the code this change started from; `undefined` means no triage. */
  readonly baseline: Effect.Effect<GateBaseline | undefined, FlowError>
  /** Root prefixes stripped from gate output before comparing (the work dir, the app dir). */
  readonly roots: ReadonlyArray<string>
  /** Re-run the test gate alone to tell a flaky line from a new one; omit to never rerun. */
  readonly rerunTest?: Effect.Effect<ReviewResult, FlowError>
}

const listed = (lines: ReadonlyArray<string>): string => lines.map((line) => `  ${line}`).join("\n")

export interface OracleGateOptions {
  /** The change under review as a unified diff (committed and uncommitted). */
  readonly diff: Effect.Effect<string, FlowError>
  readonly rules?: OracleRules
  /** The plan entry says tests may change (`testsChange: true`); the guard then stays silent. */
  readonly declared?: boolean
  /** Tests passing on the base, from its baseline; omitted or `undefined` skips the count check. */
  readonly baseCount?: Effect.Effect<number | undefined, FlowError>
}

/**
 * The oracle guard (ADR 0027 decision 4) joined to a lint result: deleted
 * test files, added skip or focus markers and a passed-count drop become
 * Critical issues the fix round can undo. When a count is unknown on either
 * side the comparison is skipped and said once.
 */
export const withOracle = Effect.fn("@llm4ts/flow/Review.withOracle")(function* (
  lint: ReviewResult,
  oracle: OracleGateOptions | undefined,
  events: FlowEventsShape,
  noted: Ref.Ref<boolean>
): Effect.fn.Return<ReviewResult, FlowError> {
  if (oracle === undefined || oracle.declared === true) {
    return lint
  }
  const diff = yield* oracle.diff
  const base = oracle.baseCount === undefined ? undefined : yield* oracle.baseCount
  if ((base === undefined || lint.passed === undefined) && !(yield* Ref.get(noted))) {
    yield* Ref.set(noted, true)
    yield* events.publish(
      Info.make({
        message:
          "oracle guard: no passed-test count on the base or the change (no summary line the guard reads), count comparison skipped"
      })
    )
  }
  const issues = checkOracle(
    parseUnifiedDiff(diff),
    { base, current: lint.passed },
    oracle.rules ?? defaultOracleRules,
    false
  )
  return issues.length === 0
    ? lint
    : ReviewResult.make({
        issues: [...lint.issues, ...issues],
        summary: [lint.summary, "oracle guard"].filter((part) => part.length > 0).join("; "),
        ...(lint.passed === undefined ? {} : { passed: lint.passed })
      })
})

/**
 * Charges a lint result only with what the change caused (ADR 0027).
 * Inherited lines are published once per `reported` set as Info; with
 * `rerunTest`, a new line that is green on one rerun of the test gate is
 * flaky: published, not charged. Without options or a baseline the result
 * is returned as is.
 */
export const applyTriage = Effect.fn("@llm4ts/flow/Review.applyTriage")(function* (
  lint: ReviewResult,
  triage: GateTriageOptions | undefined,
  events: FlowEventsShape,
  reported: Ref.Ref<ReadonlySet<string>>
): Effect.fn.Return<ReviewResult, FlowError> {
  if (triage === undefined || lint.isClean) {
    return lint
  }
  const baseline = yield* triage.baseline
  if (baseline === undefined) {
    return lint
  }
  let triaged = triageGates(lint, baseline, triage.roots)
  const seen = yield* Ref.get(reported)
  const unseen = triaged.inherited.filter((line) => !seen.has(line))
  if (unseen.length > 0) {
    yield* Ref.update(reported, (set) => new Set([...set, ...unseen]))
    yield* events.publish(
      Info.make({
        message: `${unseen.length} gate failure(s) inherited from the base, not charged to this change:\n${listed(unseen)}`
      })
    )
  }
  if (!triaged.blocking.isClean && triaged.newLines.length > 0 && triage.rerunTest !== undefined) {
    const again = yield* triage.rerunTest
    const stillRed = new Set(triageGates(again, baseline, triage.roots).newLines)
    const flaky = triaged.newLines.filter((line) => !stillRed.has(line))
    if (flaky.length > 0) {
      yield* events.publish(
        Info.make({
          message: `${flaky.length} gate failure(s) flaky (red once, green on rerun), not charged:\n${listed(flaky)}`
        })
      )
      triaged = triageGates(
        again,
        GateBaseline.make({ ...baseline, failingLines: [...baseline.failingLines, ...flaky] }),
        triage.roots
      )
    }
  }
  return triaged.blocking
})

export const mergeReviewResults = (results: ReadonlyArray<ReviewResult>): ReviewResult => {
  const counts = results.flatMap((result) => (result.passed === undefined ? [] : [result.passed]))
  return ReviewResult.make({
    issues: results.flatMap((result) => result.issues),
    summary: results
      .map((result) => result.summary)
      .filter((summary) => summary.length > 0)
      .join("; "),
    // Several gates may count tests (unit and e2e): the sum is what the change must keep.
    ...(counts.length === 0 ? {} : { passed: counts.reduce((sum, value) => sum + value, 0) })
  })
}

const processProblem = (
  stdout: ReadonlyArray<string>,
  stderr: ReadonlyArray<string>,
  exitCode: number
): string => {
  const detail = [...stdout, ...stderr].join("\n").trim()
  return detail.length === 0 ? `process exited with code ${exitCode}` : detail
}

export interface LintCommandOptions {
  /** Kill the gate after this long; the issue is then `gateClass: "hang"`. Default: never. */
  readonly timeout?: Duration.Duration
  /** Write the gate's whole stdout and stderr here; the issue carries `logPath`. */
  readonly log?: { readonly files: PlainFileStoreShape; readonly path: string }
}

const gateClassOf = (exitCode: number): "red" | "crash" => (exitCode >= 128 ? "crash" : "red")

export const lintCommand = Effect.fn("@llm4ts/flow/Review.lintCommand")(function* (
  process: ProcessExecutorShape,
  events: FlowEventsShape,
  command: ReadonlyArray<string>,
  workDir: string,
  options: LintCommandOptions = {}
): Effect.fn.Return<ReviewResult, FlowError> {
  const executable = command[0]
  if (executable === undefined) {
    return ReviewResult.make({ issues: [], summary: "" })
  }
  const label = command.join(" ")
  const started = yield* Clock.currentTimeMillis
  const run = guarded(
    Capabilities.Exec(executable),
    `lint: ${label}`,
    events,
    process.run(command, workDir, {}).pipe(
      Effect.mapError((cause) =>
        ProcessError.make({
          message: label,
          detail: cause.message
        })
      )
    )
  )
  // Interrupting `run` interrupts the child through the executor's scope;
  // `undefined` here means the gate never exited (ADR 0027: a hang is a
  // gate failure that says so, never a stuck run).
  const bounded: Effect.Effect<ProcessResult | undefined, FlowError> =
    options.timeout === undefined
      ? run
      : run.pipe(
          Effect.timeoutOption(options.timeout),
          Effect.map((option) => (option._tag === "Some" ? option.value : undefined))
        )
  // A TOOL span (ADR 0026) and a Timed event: the command as configured and
  // its exit code, never its output.
  const result = yield* withKindSpan(
    `gate ${label}`,
    { kind: "TOOL", attributes: { [attr.gateCommand]: label } },
    bounded.pipe(
      Effect.tap((ran) =>
        ran === undefined ? Effect.void : Effect.annotateCurrentSpan(attr.gateExit, ran.exitCode)
      )
    )
  )
  const failed = result === undefined || result.exitCode !== 0
  yield* events.publish(
    Timed.make({
      kind: "gate",
      label,
      ms: (yield* Clock.currentTimeMillis) - started,
      ...(result === undefined ? {} : { exitCode: result.exitCode }),
      ...(failed ? { failed: true } : {})
    })
  )
  let logPath: string | undefined
  if (options.log !== undefined) {
    const output =
      result === undefined ? "" : [...result.stdout, ...result.stderr].join("\n").trim()
    yield* options.log.files.writeAtomic(options.log.path, output)
    logPath = options.log.path
  }
  const passed =
    result === undefined
      ? undefined
      : passedCountIn([...result.stdout, ...result.stderr].join("\n"))
  if (result !== undefined && result.exitCode === 0) {
    return ReviewResult.make({
      issues: [],
      summary: "lint passed",
      ...(passed === undefined ? {} : { passed })
    })
  }
  const seconds =
    options.timeout === undefined ? 0 : Math.round(Duration.toSeconds(options.timeout))
  return ReviewResult.make({
    issues: [
      ReviewIssue.make({
        severity: "Critical",
        title: `lint failed: ${label}`,
        description:
          result === undefined
            ? `gate killed: no exit after ${seconds} seconds (LLM4TS_GATE_TIMEOUT)`
            : processProblem(result.stdout, result.stderr, result.exitCode),
        gateClass: result === undefined ? "hang" : gateClassOf(result.exitCode),
        ...(logPath === undefined ? {} : { logPath })
      })
    ],
    summary: "lint failed",
    ...(passed === undefined ? {} : { passed })
  })
})

const placeKey = (issue: ReviewIssue): string =>
  issue.file === undefined
    ? `title:${issue.title.trim().toLowerCase()}`
    : `${issue.file}:${issue.line ?? ""}`

/**
 * Independent votes of one lens merged (ADR 0027 decision 7): any Critical
 * blocks; Warnings are unioned, one per place; an Info survives only when
 * more than one vote raised it.
 */
export const mergeVotes = (votes: ReadonlyArray<ReviewResult>): ReviewResult => {
  if (votes.length <= 1) {
    return votes[0] ?? ReviewResult.make({ issues: [] })
  }
  const seen = new Map<string, { issue: ReviewIssue; count: number }>()
  for (const vote of votes) {
    for (const issue of vote.issues) {
      const key = `${issue.severity}|${placeKey(issue)}`
      const entry = seen.get(key)
      if (entry === undefined) {
        seen.set(key, { issue, count: 1 })
      } else {
        entry.count += 1
      }
    }
  }
  const issues = [...seen.values()]
    .filter(({ issue, count }) => issue.severity !== "Info" || count > 1)
    .map(({ issue }) => issue)
  return ReviewResult.make({
    issues,
    summary: votes
      .map((vote) => vote.summary)
      .filter((summary) => summary.length > 0)
      .join(" | ")
  })
}

const inDiff = (file: string, changed: ReadonlyArray<string>): boolean => {
  const wanted = file.replace(/^\.\//u, "")
  return changed.some(
    (path) => path === wanted || path.endsWith(`/${wanted}`) || wanted.endsWith(`/${path}`)
  )
}

/**
 * Findings that cannot be placed move down (ADR 0027 decision 10): a Critical
 * without a file becomes a Warning, a finding whose file is not in the diff
 * becomes an Info. Nothing is dropped; each move is published. With no
 * changed-file list the result is returned as is.
 */
export const demoteUnplaced = Effect.fn("@llm4ts/flow/Review.demoteUnplaced")(function* (
  lens: Reviewer,
  result: ReviewResult,
  changed: ReadonlyArray<string>,
  events: FlowEventsShape
): Effect.fn.Return<ReviewResult> {
  if (changed.length === 0) {
    return result
  }
  const issues: Array<ReviewIssue> = []
  for (const issue of result.issues) {
    let to: ReviewIssue["severity"] = issue.severity
    let reason: string | undefined
    if (issue.file !== undefined && !inDiff(issue.file, changed)) {
      to = "Info"
      reason = `names ${issue.file}, which the diff does not touch`
    } else if (issue.file === undefined && issue.severity === "Critical") {
      to = "Warning"
      reason = "a Critical with no file"
    }
    if (reason !== undefined && to !== issue.severity) {
      yield* events.publish(
        ReviewFindingDemoted.make({
          lens: lens.name,
          title: issue.title,
          from: issue.severity,
          to,
          reason
        })
      )
      issues.push(ReviewIssue.make({ ...issue, severity: to }))
    } else {
      issues.push(issue)
    }
  }
  return ReviewResult.make({ issues, summary: result.summary })
})

/** The repository's own review rules file, loaded as one extra lens; `undefined` when absent. */
export const repoReviewRulesPath = ".llm4ts/review-rules.md"

export const loadRepoReviewRules = (
  files: PlainFileStoreShape,
  workDir: string
): Effect.Effect<Reviewer | undefined, FlowError> =>
  files
    .read(join(workDir, repoReviewRulesPath))
    .pipe(
      Effect.map((text) =>
        text === undefined || text.trim().length === 0
          ? undefined
          : parseReviewer("repo-rules", text)
      )
    )

export interface ReviewAndFixOptions {
  readonly reviewers: ReadonlyArray<Reviewer>
  readonly reviewerService: LlmServiceShape
  readonly coder: Chat
  readonly taskTitle: string
  readonly currentDiff: Effect.Effect<string, FlowError>
  readonly events: FlowEventsShape
  readonly changedFiles?: Effect.Effect<ReadonlyArray<string>, FlowError>
  readonly maxRounds?: number
  readonly selector?: ReviewerSelector
  readonly lint?: Effect.Effect<ReviewResult, FlowError>
  readonly parallelism?: number
  readonly format?: Effect.Effect<void, FlowError>
  /**
   * A judgment pre-screen (ADR 0017): one Truth question per lens over the
   * diff. Observes by default, keeping every selected lens; only explicit
   * act mode skips lenses. Omit to disable the judgment entirely.
   */
  readonly prescreen?: ReviewPrescreen
  /**
   * Where each lens's answer is kept beside a fingerprint of the lens, the
   * task and the diff: a rerun over an unchanged diff reuses it instead of
   * asking again. One file per lens under `dir`.
   */
  readonly cache?: ReviewCacheLocation
  /** Told after every round's findings are published, settled or not. */
  readonly onRound?: (
    round: number,
    result: ReviewResult,
    settled: boolean
  ) => Effect.Effect<void, FlowError>
  /** Charge the lint gate only with failures the change caused (ADR 0027). */
  readonly triage?: GateTriageOptions
  /** How gate output reaches the coder in the fix prompt. */
  readonly fix?: FixPromptOptions
  /** Fail the round when the change deletes or skips tests (ADR 0027 decision 4). */
  readonly oracle?: OracleGateOptions
  /** Independent votes of the adversarial lens per round (ADR 0027 decision 7). Default 1. */
  readonly votes?: number
  /** Applies a fix prompt somewhere other than the implementer's chat (a separate fixer). */
  readonly fixWith?: (prompt: string) => Effect.Effect<string, FlowError>
  /** End the task, typed `Stalled`, when a fix round leaves the diff byte-identical (ADR 0027 decision 11). */
  readonly stallOnIdenticalDiff?: boolean
}

export interface ReviewCacheLocation {
  readonly files: PlainFileStoreShape
  readonly dir: string
}

export interface ReviewPrescreen {
  readonly judgment: JudgmentShape
  readonly policy?: JudgmentPolicy
  readonly mode?: JudgmentMode
}

export interface ReviewPrescreenResult {
  readonly reviewers: ReadonlyArray<Reviewer>
  readonly observations: ReadonlyArray<{
    readonly key: string
    readonly answer: TruthAnswer
    readonly question: ReturnType<typeof truth>
    readonly state: { readonly diff: string }
    readonly judgmentIdentity: string
    readonly decision: Decision
  }>
}

/**
 * Selected lenses and their answers for publication after review. In act mode
 * a lens is skipped only when its screen
 * answered with `act` certainty that the diff has nothing for it; doubt,
 * failure, and escalation all run the lens. Never skip on doubt.
 */
export const prescreenReviewers = Effect.fn("@llm4ts/flow/Review.prescreen")(function* (
  prescreen: ReviewPrescreen,
  events: FlowEventsShape,
  diff: string,
  lenses: ReadonlyArray<Reviewer>
): Effect.fn.Return<ReviewPrescreenResult, FlowError> {
  if (lenses.length === 0) {
    return { reviewers: lenses, observations: [] }
  }
  const policy = prescreen.policy ?? defaultJudgmentPolicy
  const state = { diff }
  const questions = Object.fromEntries(
    lenses.map((lens) => [lens.name, truth(lens.screeningStatement)])
  )
  const result = yield* prescreen.judgment.judge({ state, questions }).pipe(
    Effect.catch((error) =>
      events
        .publish(
          Info.make({
            message: `review pre-screen unavailable (${error.message}); running every lens`
          })
        )
        .pipe(Effect.as<JudgmentResult | undefined>(undefined))
    )
  )
  if (result === undefined) {
    return { reviewers: lenses, observations: [] }
  }
  const observations = lenses.flatMap((lens) => {
    const answer = result.answers[lens.name]
    return answer?.type === "truth"
      ? [
          {
            key: lens.name,
            answer,
            decision: decide(answer, policy),
            state,
            question: questions[lens.name],
            judgmentIdentity: prescreen.judgment.identity
          }
        ]
      : []
  })
  const kept =
    prescreen.mode !== "act"
      ? lenses
      : lenses.filter(
          (lens) =>
            !observations.some(
              ({ key, answer, decision }) =>
                key === lens.name && answer.truth < 0.5 && decision === "act"
            )
        )
  const skipped = lenses.filter((lens) => !kept.includes(lens))
  if (skipped.length > 0) {
    yield* events.publish(
      Info.make({
        message: `review pre-screen skipped ${skipped.map((lens) => lens.name).join(", ")}`
      })
    )
  }
  return { reviewers: kept, observations }
})

export const reviewWith = (
  service: LlmServiceShape,
  events: FlowEventsShape,
  lens: Reviewer,
  taskTitle: string,
  diff: string
): Effect.Effect<ReviewResult, FlowLlmError> => {
  const prompt = `${lensPrompt(lens)}\n\n${reviewPrompt(taskTitle, diff)}`
  // Usage is published per attempt — a schema retry costs real tokens too.
  const attempt = (text: string): Effect.Effect<ReviewResult, LlmError> =>
    service.executeStructuredWithUsage(text, ReviewResult, reviewJsonSchema).pipe(
      Effect.tap(([, usage, model]) => publishUsage(events, usage, model, "reviewer")),
      Effect.map(([result]) => result)
    )
  return attempt(prompt).pipe(
    Effect.catch((error) =>
      error._tag === "ParseError"
        ? attempt(
            `${prompt}\n\nYour previous reply failed schema validation: ${error.message}\n` +
              "Return ONLY valid JSON matching the schema."
          )
        : Effect.fail(error)
    ),
    Effect.mapError(FlowLlmError.from)
  )
}

export const reviewAndFixLoop = Effect.fn("@llm4ts/flow/Review.reviewAndFixLoop")(function* (
  options: ReviewAndFixOptions
): Effect.fn.Return<ReviewResult, FlowError> {
  const maxRounds = Math.max(1, options.maxRounds ?? 3)
  const selector = options.selector ?? allEveryRound
  // Changed files only narrow which reviewers run, so a repository that
  // cannot answer the question (no such base ref, unrelated histories, a
  // shallow clone) must not cost the caller a finished task: every reviewer
  // runs instead, which is what an empty list already means to a selector.
  const changedFiles = (options.changedFiles ?? Effect.succeed([])).pipe(
    Effect.catch((error) =>
      options.events
        .publish(
          Info.make({
            message: `could not determine the changed files (${describeFlowError(error)}) — running every reviewer`
          })
        )
        .pipe(Effect.as<ReadonlyArray<string>>([]))
    )
  )
  const format = options.format ?? Effect.void
  const reported = yield* Ref.make<ReadonlySet<string>>(new Set())
  const oracleNoted = yield* Ref.make(false)

  const reviewOnce = (
    round: number,
    previous: ReviewResult | undefined
  ): Effect.Effect<ReviewResult, FlowError> =>
    Effect.gen(function* () {
      const lintRaw = yield* options.lint ?? Effect.succeed(ReviewResult.make({ issues: [] }))
      const lint = yield* withOracle(
        yield* applyTriage(lintRaw, options.triage, options.events, reported),
        options.oracle,
        options.events,
        oracleNoted
      )
      if (!lint.isClean) {
        return lint
      }
      const diff = yield* options.currentDiff
      const files = yield* changedFiles
      const selected = yield* selector.select(options.reviewers, files, round, previous)
      const screened =
        options.prescreen === undefined
          ? { reviewers: selected, observations: [] }
          : yield* prescreenReviewers(options.prescreen, options.events, diff, selected)
      const chosen = screened.reviewers
      const cache = options.cache
      const votes = Math.max(1, options.votes ?? 1)
      const reviewVote = (lens: Reviewer, vote: number): Effect.Effect<ReviewResult, FlowError> =>
        cache === undefined
          ? reviewWith(options.reviewerService, options.events, lens, options.taskTitle, diff)
          : cachedReview(
              cache.files,
              join(cache.dir, `${fileSlug(lens.name)}${vote === 0 ? "" : `-vote${vote}`}.json`),
              fingerprintOf([lens.name, lensPrompt(lens), String(vote), options.taskTitle, diff]),
              reviewWith(options.reviewerService, options.events, lens, options.taskTitle, diff)
            )
      // Votes multiply only the adversarial lens: its recall is what independent
      // eyes improve; the concern lenses are cheap scoped questions.
      const review = (lens: Reviewer): Effect.Effect<ReviewResult, FlowError> =>
        lens.name === adversarialReviewer.name && votes > 1
          ? Effect.map(
              Effect.forEach(
                Array.from({ length: votes }, (_, index) => index),
                (vote) => reviewVote(lens, vote),
                { concurrency: "unbounded" }
              ),
              mergeVotes
            )
          : reviewVote(lens, 0)
      const run = (lens: Reviewer) =>
        Effect.flatMap(review(lens), (result) =>
          Effect.map(demoteUnplaced(lens, result, files, options.events), (placed) => ({
            lens,
            result: placed
          }))
        )
      const parallelism = options.parallelism ?? 0
      const results =
        parallelism > 0
          ? yield* Effect.forEach(chosen, run, { concurrency: parallelism })
          : yield* Effect.forEach(chosen, run, { concurrency: "unbounded" })
      const mode = options.prescreen?.mode ?? "observe"
      if (mode !== "act") {
        for (const { lens, result } of results) {
          const observation = screened.observations.find(({ key }) => key === lens.name)
          if (observation === undefined) continue
          const { key, answer, decision, state, question, judgmentIdentity } = observation
          const counts = { Critical: 0, Warning: 0, Info: 0 }
          for (const issue of result.issues) counts[issue.severity] += 1
          yield* publishJudgmentObserved(
            options.events,
            JudgmentObserved.make({
              consumer: "review-prescreen",
              state,
              question,
              answer,
              judgmentIdentity,
              key,
              decision,
              certainty: certaintyOf(answer),
              support: answer.support,
              origin: answer.origin,
              outcome: { _tag: "ReviewPrescreen", lens: lens.name, issues: counts },
              mode
            })
          )
        }
      }
      return mergeReviewResults(results.map(({ result }) => result))
    })

  const lastDiff = yield* Ref.make<string | undefined>(undefined)
  const loop = (
    round: number,
    previous: ReviewResult | undefined
  ): Effect.Effect<ReviewResult, FlowError> =>
    Effect.gen(function* () {
      yield* format
      // A fix round that changed nothing is a loop going nowhere (ADR 0027
      // decision 11): the same diff twice in a row ends the task, typed.
      const diffNow = yield* options.currentDiff
      const before = yield* Ref.get(lastDiff)
      if (
        options.stallOnIdenticalDiff === true &&
        round > 1 &&
        before !== undefined &&
        before === diffNow &&
        previous !== undefined
      ) {
        return yield* Stalled.make({
          signal: "identical-diff",
          detail: `review round ${round} found the diff unchanged after the fix for ${previous.issues.length} finding(s)`
        })
      }
      yield* Ref.set(lastDiff, diffNow)
      const result = yield* reviewOnce(round, previous)
      const settled = result.isClean || round >= maxRounds
      yield* options.events.publish(
        ReviewFindings.make({
          round,
          settled,
          issues: result.issues.map((issue) =>
            ReviewFinding.make({
              severity: issue.severity,
              title: issue.title,
              ...(issue.file === undefined ? {} : { file: issue.file }),
              ...(issue.line === undefined ? {} : { line: issue.line })
            })
          )
        })
      )
      if (options.onRound !== undefined) {
        yield* options.onRound(round, result, settled)
      }
      if (settled) {
        return result
      }
      const fix = fixPrompt(result, options.fix)
      yield* options.fixWith === undefined ? options.coder.ask(fix) : options.fixWith(fix)
      return yield* loop(round + 1, result)
    })

  return yield* loop(1, undefined)
})
