import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { LlmError } from "@llm4ts/core/Errors"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import type { JsonSchema } from "@llm4ts/core/Models"
import type { ProcessExecutorShape } from "@llm4ts/core/ProcessExecutor"
import { Capabilities } from "@llm4ts/core/Capability"
import { guarded } from "./CapabilityGuard.ts"
import type { Chat } from "./Chat.ts"
import { FlowLlmError, ProcessError, describeFlowError, type FlowError } from "./FlowError.ts"
import {
  Info,
  JudgmentObserved,
  ReviewFinding,
  ReviewFindings,
  publishJudgmentObserved,
  type FlowEventsShape
} from "./FlowEvents.ts"
import { Reviewer } from "./Reviewer.ts"
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
  )
}) {}

export class ReviewResult extends Schema.Class<ReviewResult>("ReviewResult")({
  issues: Schema.Array(ReviewIssue),
  summary: Schema.String.pipe(
    Schema.withConstructorDefault(Effect.succeed("")),
    Schema.withDecodingDefaultKey(Effect.succeed(""))
  )
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
  correctnessReviewer,
  readabilityReviewer,
  testReviewer
])

export const allReviewers: ReadonlyArray<Reviewer> = Object.freeze([
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

export const reviewPrompt = (task: string, diff: string): string =>
  [
    `Review the change below for task "${task}". Report problems as JSON:`,
    '{"issues":[{"severity":"Critical|Warning|Info","title":"...",',
    '"description":"..."}],"summary":"..."}.',
    'An empty "issues" array means the change is acceptable. Respond with JSON only.',
    "",
    "Diff:",
    diff
  ].join("\n")

export const fixPrompt = (result: ReviewResult): string =>
  [
    "Address these review findings, then stop:",
    ...result.issues.map((issue) => `- [${issue.severity}] ${issue.title}: ${issue.description}`)
  ].join("\n")

export const mergeReviewResults = (results: ReadonlyArray<ReviewResult>): ReviewResult =>
  ReviewResult.make({
    issues: results.flatMap((result) => result.issues),
    summary: results
      .map((result) => result.summary)
      .filter((summary) => summary.length > 0)
      .join("; ")
  })

const processProblem = (
  stdout: ReadonlyArray<string>,
  stderr: ReadonlyArray<string>,
  exitCode: number
): string => {
  const detail = [...stdout, ...stderr].join("\n").trim()
  return detail.length === 0 ? `process exited with code ${exitCode}` : detail
}

export const lintCommand = Effect.fn("@llm4ts/flow/Review.lintCommand")(function* (
  process: ProcessExecutorShape,
  events: FlowEventsShape,
  command: ReadonlyArray<string>,
  workDir: string
): Effect.fn.Return<ReviewResult, FlowError> {
  const executable = command[0]
  if (executable === undefined) {
    return ReviewResult.make({ issues: [], summary: "" })
  }
  const result = yield* guarded(
    Capabilities.Exec(executable),
    `lint: ${command.join(" ")}`,
    events,
    process.run(command, workDir, {}).pipe(
      Effect.mapError((cause) =>
        ProcessError.make({
          message: command.join(" "),
          detail: cause.message
        })
      )
    )
  )
  if (result.exitCode === 0) {
    return ReviewResult.make({ issues: [], summary: "lint passed" })
  }
  return ReviewResult.make({
    issues: [
      ReviewIssue.make({
        severity: "Critical",
        title: `lint failed: ${command.join(" ")}`,
        description: processProblem(result.stdout, result.stderr, result.exitCode)
      })
    ],
    summary: "lint failed"
  })
})

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
  const prompt = `${lens.systemPrompt}\n\n${reviewPrompt(taskTitle, diff)}`
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

  const reviewOnce = (
    round: number,
    previous: ReviewResult | undefined
  ): Effect.Effect<ReviewResult, FlowError> =>
    Effect.gen(function* () {
      const lint = yield* options.lint ?? Effect.succeed(ReviewResult.make({ issues: [] }))
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
      const run = (lens: Reviewer) =>
        reviewWith(options.reviewerService, options.events, lens, options.taskTitle, diff).pipe(
          Effect.map((result) => ({ lens, result }))
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

  const loop = (
    round: number,
    previous: ReviewResult | undefined
  ): Effect.Effect<ReviewResult, FlowError> =>
    Effect.gen(function* () {
      yield* format
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
      if (settled) {
        return result
      }
      yield* options.coder.ask(fixPrompt(result))
      return yield* loop(round + 1, result)
    })

  return yield* loop(1, undefined)
})
