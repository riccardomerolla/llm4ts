import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import type { JsonSchema } from "@llm4ts/core/Models"
import type { ProcessExecutorShape } from "@llm4ts/core/ProcessExecutor"
import { Capabilities } from "@llm4ts/core/Capability"
import { guarded } from "./CapabilityGuard.ts"
import type { Chat } from "./Chat.ts"
import { FlowLlmError, ProcessError, type FlowError } from "./FlowError.ts"
import { Info, type FlowEventsShape } from "./FlowEvents.ts"
import { Reviewer } from "./Reviewer.ts"

export const Severity = Schema.Literals(["Critical", "Warning", "Info"])
export type Severity = typeof Severity.Type

export class ReviewIssue extends Schema.Class<ReviewIssue>("ReviewIssue")({
  severity: Severity,
  title: Schema.String,
  description: Schema.String.pipe(Schema.withConstructorDefault(Effect.succeed(""))),
  file: Schema.optionalKey(Schema.String),
  line: Schema.optionalKey(Schema.Int),
  suggestion: Schema.optionalKey(Schema.String),
  confidence: Schema.Number.pipe(Schema.withConstructorDefault(Effect.succeed(1)))
}) {}

export class ReviewResult extends Schema.Class<ReviewResult>("ReviewResult")({
  issues: Schema.Array(ReviewIssue),
  summary: Schema.String.pipe(Schema.withConstructorDefault(Effect.succeed("")))
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

const reviewer = (name: string, systemPrompt: string, files = ".*"): Reviewer =>
  Reviewer.make({ name, systemPrompt, files })

export const correctnessReviewer = reviewer(
  "code-functionality",
  [
    "Review for functional correctness. Check that the change implements the task's intent,",
    "handles obvious edge cases, and does not regress existing behavior. Report only concrete",
    "logic errors, wrong conditions, mishandled error paths, and missing cases. Ignore style."
  ].join("\n")
)

export const readabilityReviewer = reviewer(
  "readability",
  [
    "Review for readability and clarity. Check names, focused functions, understandable control",
    "flow, and useful comments. Report only concrete, actionable readability problems."
  ].join("\n")
)

export const testReviewer = reviewer(
  "test",
  [
    "Review test coverage and quality. Check that new behavior and important error paths are",
    "covered by tests that assert real outcomes and would fail on regression. Report concrete gaps."
  ].join("\n")
)

export const structureReviewer = reviewer(
  "code-structure",
  "Review module boundaries, dependency direction, cohesion, and unnecessary coupling. Report concrete structural problems."
)

export const performanceReviewer = reviewer(
  "performance",
  "Review for material performance regressions, unbounded work, avoidable repeated I/O, and resource leaks."
)

export const securityReviewer = reviewer(
  "security",
  "Review trust boundaries, input handling, secrets, authorization, injection risks, and unsafe defaults."
)

export const effectReviewer = reviewer(
  "effect-ts",
  "Review Effect usage: typed errors, scoped resources, service boundaries, interruption, concurrency, and runtime ownership.",
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
}

const reviewWith = (
  service: LlmServiceShape,
  lens: Reviewer,
  taskTitle: string,
  diff: string
): Effect.Effect<ReviewResult, FlowLlmError> =>
  service
    .executeStructured(
      `${lens.systemPrompt}\n\n${reviewPrompt(taskTitle, diff)}`,
      ReviewResult,
      reviewJsonSchema
    )
    .pipe(Effect.mapError(FlowLlmError.from))

export const reviewAndFixLoop = Effect.fn("@llm4ts/flow/Review.reviewAndFixLoop")(function* (
  options: ReviewAndFixOptions
): Effect.fn.Return<ReviewResult, FlowError> {
  const maxRounds = Math.max(1, options.maxRounds ?? 3)
  const selector = options.selector ?? allEveryRound
  const changedFiles = options.changedFiles ?? Effect.succeed([])
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
      const chosen = yield* selector.select(options.reviewers, files, round, previous)
      const run = (lens: Reviewer) =>
        reviewWith(options.reviewerService, lens, options.taskTitle, diff)
      const parallelism = options.parallelism ?? 0
      const results =
        parallelism > 0
          ? yield* Effect.forEach(chosen, run, { concurrency: parallelism })
          : yield* Effect.forEach(chosen, run, { concurrency: "unbounded" })
      return mergeReviewResults(results)
    })

  const loop = (
    round: number,
    previous: ReviewResult | undefined
  ): Effect.Effect<ReviewResult, FlowError> =>
    Effect.gen(function* () {
      yield* format
      const result = yield* reviewOnce(round, previous)
      const verdict = result.isClean ? "clean" : `${result.issues.length} issue(s)`
      if (result.isClean || round >= maxRounds) {
        yield* options.events.publish(
          Info.make({ message: `review settled after round ${round}: ${verdict}` })
        )
        return result
      }
      yield* options.events.publish(
        Info.make({ message: `review round ${round}: ${verdict}, fixing` })
      )
      yield* options.coder.ask(fixPrompt(result))
      return yield* loop(round + 1, result)
    })

  return yield* loop(1, undefined)
})
