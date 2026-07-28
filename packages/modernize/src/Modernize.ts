import * as Effect from "effect/Effect"
import type { FlowError } from "@llm4ts/flow/FlowError"
import type { PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import { loadVersioned, saveVersioned } from "@llm4ts/flow/Persistence"
import { requireApproval } from "./Approval.ts"
import {
  CurrentModernizeStateVersion,
  defaultModernizeStatePath,
  initialModernizeState,
  InvalidPhaseTransition,
  ModernizeState,
  PhaseCheckpoint,
  type ModernizeError,
  type ModernizePhase,
  type PhaseOutcome,
  modernizePhases
} from "./Model.ts"

export interface ModernizeHandlers<E, R> {
  readonly survey: Effect.Effect<PhaseOutcome, E, R>
  readonly extract: Effect.Effect<PhaseOutcome, E, R>
  readonly seed: Effect.Effect<PhaseOutcome, E, R>
  readonly implement: Effect.Effect<PhaseOutcome, E, R>
  readonly verify: Effect.Effect<PhaseOutcome, E, R>
  readonly review: Effect.Effect<PhaseOutcome, E, R>
}

export interface ModernizeApprovalPaths {
  readonly wavePlan: string
  readonly specificationPack: string
}

export interface ModernizeRunOptions {
  readonly project: string
  readonly statePath?: string
  readonly through?: ModernizePhase
}

export interface ModernizeShape<E, R> {
  readonly run: (
    options: ModernizeRunOptions
  ) => Effect.Effect<ModernizeState, E | FlowError | ModernizeError, R>
  readonly load: (path?: string) => Effect.Effect<ModernizeState | undefined, FlowError>
}

const replaceCheckpoint = (state: ModernizeState, next: PhaseCheckpoint): ModernizeState =>
  new ModernizeState({
    ...state,
    checkpoints: state.checkpoints.map((checkpoint) =>
      checkpoint.phase === next.phase ? next : checkpoint
    )
  })

const errorMessage = (error: unknown): string =>
  error instanceof Error && error.message.length > 0 ? error.message : String(error)

const assertPredecessors = (
  state: ModernizeState,
  phase: ModernizePhase
): Effect.Effect<void, InvalidPhaseTransition> => {
  const position = modernizePhases.indexOf(phase)
  const incomplete = state.checkpoints
    .slice(0, position)
    .find((checkpoint) => checkpoint.status !== "completed")
  return incomplete === undefined
    ? Effect.void
    : Effect.fail(
        InvalidPhaseTransition.make({
          phase,
          message: `phase '${phase}' cannot run before '${incomplete.phase}' completes`
        })
      )
}

export const makeModernize = <E, R>(
  files: PlainFileStoreShape,
  handlers: ModernizeHandlers<E, R>
): ModernizeShape<E, R> => {
  const load = (
    path = defaultModernizeStatePath
  ): Effect.Effect<ModernizeState | undefined, FlowError> =>
    loadVersioned(files, path, CurrentModernizeStateVersion, ModernizeState)

  const persist = (path: string, state: ModernizeState): Effect.Effect<void, FlowError> =>
    saveVersioned(files, path, CurrentModernizeStateVersion, ModernizeState, state)

  const run = Effect.fn("@llm4ts/modernize/Modernize.run")(function* (
    options: ModernizeRunOptions
  ): Effect.fn.Return<ModernizeState, E | FlowError | ModernizeError, R> {
    const path = options.statePath ?? defaultModernizeStatePath
    let state = (yield* load(path)) ?? initialModernizeState(options.project)
    if (state.project !== options.project) {
      return yield* InvalidPhaseTransition.make({
        phase: "survey",
        message: `state belongs to '${state.project}', not '${options.project}'`
      })
    }
    yield* persist(path, state)
    const through =
      options.through === undefined
        ? modernizePhases.length - 1
        : modernizePhases.indexOf(options.through)

    for (const phase of modernizePhases.slice(0, through + 1)) {
      const checkpoint = state.checkpoint(phase)
      if (checkpoint.status === "completed") {
        continue
      }
      yield* assertPredecessors(state, phase)
      state = replaceCheckpoint(
        state,
        PhaseCheckpoint.make({
          phase,
          status: "running",
          attempts: checkpoint.attempts + 1
        })
      )
      yield* persist(path, state)
      const result = yield* Effect.result(handlers[phase])
      if (result._tag === "Failure") {
        state = replaceCheckpoint(
          state,
          PhaseCheckpoint.make({
            phase,
            status: "failed",
            attempts: checkpoint.attempts + 1,
            failure: errorMessage(result.failure)
          })
        )
        yield* persist(path, state)
        return yield* Effect.fail(result.failure)
      }
      state = replaceCheckpoint(
        state,
        PhaseCheckpoint.make({
          phase,
          status: "completed",
          attempts: checkpoint.attempts + 1,
          summary: result.success.summary,
          artifacts: result.success.artifacts
        })
      )
      yield* persist(path, state)
    }
    return state
  })

  return { run, load }
}

export const withModernizeApprovals = <E, R>(
  files: PlainFileStoreShape,
  approvals: ModernizeApprovalPaths,
  handlers: ModernizeHandlers<E, R>
): ModernizeHandlers<E | FlowError | ModernizeError, R> => ({
  ...handlers,
  extract: requireApproval(files, approvals.wavePlan).pipe(Effect.andThen(handlers.extract)),
  seed: requireApproval(files, approvals.specificationPack).pipe(Effect.andThen(handlers.seed))
})
