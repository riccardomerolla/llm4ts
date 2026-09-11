import * as Schema from "effect/Schema"
import { Capability } from "@llm4ts/core/Capability"
import { LlmError } from "@llm4ts/core/Errors"

export class PersistenceError extends Schema.TaggedErrorClass<PersistenceError>()("Persistence", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect())
}) {}

export class PlanParseError extends Schema.TaggedErrorClass<PlanParseError>()("PlanParse", {
  message: Schema.String
}) {}

export class UnsupportedSchemaVersion extends Schema.TaggedErrorClass<UnsupportedSchemaVersion>()(
  "UnsupportedSchemaVersion",
  {
    path: Schema.String,
    expected: Schema.Int,
    actual: Schema.Int
  }
) {
  get message(): string {
    return `unsupported schema version in ${this.path}: expected ${this.expected}, received ${this.actual}`
  }
}

export class WorkspacePathError extends Schema.TaggedErrorClass<WorkspacePathError>()(
  "WorkspacePath",
  {
    path: Schema.String,
    message: Schema.String
  }
) {}

export class WorkspaceLimitError extends Schema.TaggedErrorClass<WorkspaceLimitError>()(
  "WorkspaceLimit",
  {
    operation: Schema.String,
    limit: Schema.Int,
    actual: Schema.Int,
    path: Schema.optionalKey(Schema.String)
  }
) {
  get message(): string {
    const where = this.path === undefined ? "" : ` (${this.path})`
    return `${this.operation} exceeded limit ${this.limit}; received ${this.actual}${where}`
  }
}

export class WorkspaceIoError extends Schema.TaggedErrorClass<WorkspaceIoError>()("WorkspaceIo", {
  operation: Schema.String,
  path: Schema.String,
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect())
}) {}

export class FlowAborted extends Schema.TaggedErrorClass<FlowAborted>()("Aborted", {
  message: Schema.String
}) {}

export class ProcessError extends Schema.TaggedErrorClass<ProcessError>()("Process", {
  message: Schema.String,
  detail: Schema.String
}) {}

/**
 * A failure rendered for a human. `ProcessError.message` is only the command
 * that failed — reporting it alone (`git diff --name-only main...HEAD`) says
 * nothing about why, so the process output that explains it is appended.
 */
export const describeFlowError = (error: unknown): string => {
  const base = error instanceof Error && error.message.length > 0 ? error.message : String(error)
  const detail =
    typeof error === "object" &&
    error !== null &&
    "detail" in error &&
    typeof error.detail === "string"
      ? error.detail.trim()
      : ""
  return detail.length === 0 || base.includes(detail) ? base : `${base}: ${detail}`
}

export class FlowLlmError extends Schema.TaggedErrorClass<FlowLlmError>()("Llm", {
  message: Schema.String,
  cause: Schema.optionalKey(LlmError)
}) {
  static readonly from = (cause?: typeof LlmError.Type): FlowLlmError =>
    FlowLlmError.make({
      message: cause?.message ?? "LLM request failed",
      ...(cause === undefined ? {} : { cause })
    })
}

export class FlowCapabilityDenied extends Schema.TaggedErrorClass<FlowCapabilityDenied>()(
  "CapabilityDenied",
  {
    capability: Capability,
    operation: Schema.String
  }
) {
  get message(): string {
    const capability =
      this.capability._tag === "Exec" ? `Exec(${this.capability.command})` : this.capability._tag
    return `capability ${capability} denied for ${this.operation}`
  }
}

export class ColumnNotFound extends Schema.TaggedErrorClass<ColumnNotFound>()("ColumnNotFound", {
  title: Schema.String,
  available: Schema.Array(Schema.String)
}) {
  get message(): string {
    return `column "${this.title}" not found on the card table; available: ${this.available.join(", ")}`
  }
}

export class BudgetExceeded extends Schema.TaggedErrorClass<BudgetExceeded>()("BudgetExceeded", {
  metric: Schema.Literals(["tokens", "costUsd"]),
  limit: Schema.Number,
  actual: Schema.Number
}) {
  get message(): string {
    return `${this.metric} budget exceeded: limit ${this.limit}, actual ${this.actual}`
  }
}

/** A story plan that failed deterministic validation — every violation, not the first (ADR 0013). */
export class StoryPlanInvalid extends Schema.TaggedErrorClass<StoryPlanInvalid>()(
  "StoryPlanInvalid",
  {
    violations: Schema.Array(Schema.String)
  }
) {
  get message(): string {
    return `story plan invalid:\n${this.violations.map((violation) => `- ${violation}`).join("\n")}`
  }
}

/** A story branch changed paths outside the story's declared `owned` set. */
export class PerimeterViolation extends Schema.TaggedErrorClass<PerimeterViolation>()(
  "PerimeterViolation",
  {
    story: Schema.String,
    outside: Schema.Array(Schema.String),
    sharedReadOnly: Schema.Array(Schema.String)
  }
) {
  get message(): string {
    const lines = [`story '${this.story}' changed paths outside its perimeter:`]
    for (const path of this.sharedReadOnly) {
      lines.push(`- ${path} (shared read-only: revert it, or request it as a dedicated story)`)
    }
    for (const path of this.outside) {
      lines.push(`- ${path} (not in the story's owned paths)`)
    }
    return lines.join("\n")
  }
}

/** The coder ended a story with `BLOCKED_ON:` — unplanned work belongs to another story. */
export class MissingDependency extends Schema.TaggedErrorClass<MissingDependency>()(
  "MissingDependency",
  {
    story: Schema.String,
    need: Schema.String
  }
) {
  get message(): string {
    return `story '${this.story}' is blocked on unplanned work: ${this.need}`
  }
}

/** A story branch did not merge cleanly into the epic branch; the merge was aborted. */
export class MergeConflict extends Schema.TaggedErrorClass<MergeConflict>()("MergeConflict", {
  branch: Schema.String,
  into: Schema.String,
  paths: Schema.Array(Schema.String)
}) {
  get message(): string {
    const where = this.paths.length === 0 ? "" : `: ${this.paths.join(", ")}`
    return `merging '${this.branch}' into '${this.into}' conflicted${where}`
  }
}

/** One story failed; carries the story id so a fail-fast run names its cause. */
export class StoryFailed extends Schema.TaggedErrorClass<StoryFailed>()("StoryFailed", {
  story: Schema.String,
  reason: Schema.String
}) {
  get message(): string {
    return `story '${this.story}' failed: ${this.reason}`
  }
}

export const FlowError = Schema.Union([
  PersistenceError,
  PlanParseError,
  UnsupportedSchemaVersion,
  WorkspacePathError,
  WorkspaceLimitError,
  WorkspaceIoError,
  FlowAborted,
  ProcessError,
  FlowLlmError,
  FlowCapabilityDenied,
  ColumnNotFound,
  BudgetExceeded,
  StoryPlanInvalid,
  PerimeterViolation,
  MissingDependency,
  MergeConflict,
  StoryFailed
])
export type FlowError = typeof FlowError.Type
