import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { matchingFiles } from "./SpecChecks.ts"
import type { WorkspaceError, WorkspaceShape } from "./Workspace.ts"

/**
 * The enforced clean-room wall: target-phase flows (implement, verify, review)
 * refuse to run when the target workspace contains anything matching the pack's
 * legacy `sources:` regex, so the coder provably never has legacy source in
 * reach. A breach is a recoverable, typed outcome — the caller decides to
 * abort; only I/O failure fails the effect.
 */
export class WallClean extends Schema.TaggedClass<WallClean>()("Clean", {}) {}

export class WallBreached extends Schema.TaggedClass<WallBreached>()("Breached", {
  paths: Schema.Array(Schema.String)
}) {}

export const WallResult = Schema.Union([WallClean, WallBreached])
export type WallResult = typeof WallResult.Type

/**
 * Scans the working tree for files matching the pack's legacy `sourcesRegex`.
 * `.git` is exempt — the wall is about the working tree, not repository
 * internals.
 */
export const checkWall = Effect.fn("@llm4ts/flow/Wall.check")(function* (
  workspace: WorkspaceShape,
  sourcesRegex: string
): Effect.fn.Return<WallResult, WorkspaceError> {
  const matches = (yield* matchingFiles(workspace, sourcesRegex)).filter(
    (path) => !path.startsWith(".git/")
  )
  return matches.length === 0 ? new WallClean() : new WallBreached({ paths: matches })
})

/** The one-line breach message every target-phase flow reports, capped at ten paths. */
export const wallBreachMessage = (breach: WallBreached, consequence: string): string => {
  const shown = breach.paths.slice(0, 10).join(", ")
  const more = breach.paths.length > 10 ? ` (+${breach.paths.length - 10} more)` : ""
  return `clean-room wall breached — legacy source inside the target workspace: ${shown}${more}. ${consequence}`
}
