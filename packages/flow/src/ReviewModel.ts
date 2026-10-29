/**
 * What a review answers: findings and their result. Kept apart from
 * `Review.ts` so modules that `Review.ts` imports can build schemas over them
 * at load time without an import cycle (ADR 0044).
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

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
  /** Why a test gate's output could not stand for green: no tests ran, or test files failed to load. */
  gateReason: Schema.optionalKey(Schema.Literals(["zero-tests", "load-failure"])),
  /** Where the gate's full output was written, when the caller asked for a log. */
  logPath: Schema.optionalKey(Schema.String),
  /** The reviewer that raised it (ADR 0044): a lens name, or "judge"; absent for gate findings. */
  lens: Schema.optionalKey(Schema.String)
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
