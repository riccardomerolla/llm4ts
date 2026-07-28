import * as Schema from "effect/Schema"
import * as Effect from "effect/Effect"

export const ModernizePhase = Schema.Literals([
  "survey",
  "extract",
  "seed",
  "implement",
  "verify",
  "review"
])
export type ModernizePhase = typeof ModernizePhase.Type

export const modernizePhases: ReadonlyArray<ModernizePhase> = Object.freeze([
  "survey",
  "extract",
  "seed",
  "implement",
  "verify",
  "review"
])

export const PhaseStatus = Schema.Literals(["pending", "running", "completed", "failed"])
export type PhaseStatus = typeof PhaseStatus.Type

export class PhaseCheckpoint extends Schema.Class<PhaseCheckpoint>("PhaseCheckpoint")({
  phase: ModernizePhase,
  status: PhaseStatus,
  attempts: Schema.Int,
  summary: Schema.optionalKey(Schema.String),
  failure: Schema.optionalKey(Schema.String),
  artifacts: Schema.Array(Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed(Object.freeze([])))
  )
}) {}

export class ModernizeState extends Schema.Class<ModernizeState>("ModernizeState")({
  project: Schema.String,
  checkpoints: Schema.Array(PhaseCheckpoint)
}) {
  checkpoint(phase: ModernizePhase): PhaseCheckpoint {
    return (
      this.checkpoints.find((checkpoint) => checkpoint.phase === phase) ??
      PhaseCheckpoint.make({ phase, status: "pending", attempts: 0 })
    )
  }

  get completed(): boolean {
    return this.checkpoints.every((checkpoint) => checkpoint.status === "completed")
  }
}

export class PhaseOutcome extends Schema.Class<PhaseOutcome>("PhaseOutcome")({
  summary: Schema.String,
  artifacts: Schema.Array(Schema.String)
}) {}

export class InvalidPhaseTransition extends Schema.TaggedErrorClass<InvalidPhaseTransition>()(
  "InvalidPhaseTransition",
  {
    phase: ModernizePhase,
    message: Schema.String
  }
) {}

export class ApprovalRequired extends Schema.TaggedErrorClass<ApprovalRequired>()(
  "ApprovalRequired",
  {
    path: Schema.String,
    marker: Schema.String
  }
) {
  get message(): string {
    return `approval required in ${this.path}: set '${this.marker}'`
  }
}

export class MissingModernizeArtifact extends Schema.TaggedErrorClass<MissingModernizeArtifact>()(
  "MissingModernizeArtifact",
  {
    path: Schema.String,
    message: Schema.String
  }
) {}

export const ModernizeError = Schema.Union([
  InvalidPhaseTransition,
  ApprovalRequired,
  MissingModernizeArtifact
])
export type ModernizeError = typeof ModernizeError.Type

export const CurrentModernizeStateVersion = 1
export const defaultModernizeStatePath = "docs/modernization/state.json"

export const initialModernizeState = (project: string): ModernizeState =>
  ModernizeState.make({
    project,
    checkpoints: modernizePhases.map((phase) =>
      PhaseCheckpoint.make({ phase, status: "pending", attempts: 0 })
    )
  })
