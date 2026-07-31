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

export class BudgetExceeded extends Schema.TaggedErrorClass<BudgetExceeded>()("BudgetExceeded", {
  metric: Schema.Literals(["tokens", "costUsd"]),
  limit: Schema.Number,
  actual: Schema.Number
}) {
  get message(): string {
    return `${this.metric} budget exceeded: limit ${this.limit}, actual ${this.actual}`
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
  BudgetExceeded
])
export type FlowError = typeof FlowError.Type
