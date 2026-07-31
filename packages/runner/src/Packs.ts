import { existsSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { PlanParseError } from "@llm4ts/flow/FlowError"
import { loadPack, type Pack } from "@llm4ts/flow/Pack"
import { loadPatternCards, type PatternCard } from "@llm4ts/flow/Patterns"
import type { WorkspaceError, WorkspaceShape } from "@llm4ts/flow/Workspace"
import { makeNodeWorkspace } from "./NodeWorkspace.ts"

/**
 * Pack location for the modernization flows. `LLM4TS_PACK` names the pack
 * (default `packs/cobol-springboot`) and is resolved against the launch
 * directory first — a pack the user keeps next to their work wins — then
 * against the flow script's own directory, where the published shell ships
 * the built-in packs. An absolute `LLM4TS_PACK` is used as-is. The fallback
 * is what lets `llm4ts run modernize-survey --repo <estate>` work from any
 * directory instead of only from a checkout with `packs/` at its cwd.
 */

export class PackNotFound extends Schema.TaggedErrorClass<PackNotFound>()("PackNotFound", {
  message: Schema.String
}) {}

export interface LocatedPack {
  /** Directory the pack workspace is rooted at. */
  readonly root: string
  /** Pack directory relative to `root` (`"."` when the pack path is absolute). */
  readonly dir: string
}

/** The first candidate root whose `packDir` holds a `pack.md` manifest. */
export const locatePack = (
  packDir: string,
  roots: ReadonlyArray<string>
): LocatedPack | undefined => {
  if (isAbsolute(packDir)) {
    return existsSync(join(packDir, "pack.md")) ? { root: packDir, dir: "." } : undefined
  }
  for (const root of roots) {
    const resolved = resolve(root)
    if (existsSync(join(resolved, packDir, "pack.md"))) {
      return { root: resolved, dir: packDir }
    }
  }
  return undefined
}

export interface OpenedPack {
  readonly pack: Pack
  /**
   * Workspace rooted where the pack was found. Pack-relative paths — prompts,
   * `<pack>/patterns`, `lessons.md`, the scaffold — must resolve through this
   * workspace, not the launch directory's.
   */
  readonly workspace: WorkspaceShape
  /** Pack directory within `workspace`. */
  readonly dir: string
}

export const openPack = Effect.fn("@llm4ts/runner/Packs.openPack")(function* (options: {
  readonly environment: Readonly<Record<string, string | undefined>>
  /** The directory the flow was launched from (`resolveFlowInput().workspace`). */
  readonly launchDir: string
  /** The directory holding the flow script (`import.meta.dirname`). */
  readonly flowDir: string
}): Effect.fn.Return<OpenedPack, PackNotFound | WorkspaceError | PlanParseError> {
  const packDir = options.environment.LLM4TS_PACK ?? "packs/cobol-springboot"
  const located = locatePack(packDir, [options.launchDir, options.flowDir])
  if (located === undefined) {
    return yield* PackNotFound.make({
      message:
        `pack '${packDir}' not found: no ${join(packDir, "pack.md")} under ` +
        `${resolve(options.launchDir)} or ${resolve(options.flowDir)} — ` +
        "set LLM4TS_PACK or launch from a directory containing the pack"
    })
  }
  const workspace = yield* makeNodeWorkspace(located.root)
  const pack = yield* loadPack(workspace, located.dir)
  return { pack, workspace, dir: located.dir }
})

/**
 * The universal pattern cards: the first candidate root with a `patterns/`
 * directory contributes them, and no root having one is an empty set —
 * patterns are optional everywhere.
 */
export const loadUniversalPatternCards = Effect.fn(
  "@llm4ts/runner/Packs.loadUniversalPatternCards"
)(function* (
  roots: ReadonlyArray<string>
): Effect.fn.Return<ReadonlyArray<PatternCard>, WorkspaceError> {
  const root = roots
    .map((candidate) => resolve(candidate))
    .find((candidate) => existsSync(join(candidate, "patterns")))
  if (root === undefined) {
    return []
  }
  const workspace = yield* makeNodeWorkspace(root)
  return yield* loadPatternCards(workspace, "patterns")
})
