import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

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
