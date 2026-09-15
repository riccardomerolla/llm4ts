import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { PlanParseError } from "@llm4ts/flow/FlowError"
import { loadPack, type Pack } from "@llm4ts/flow/Pack"
import { loadPatternCards, type PatternCard } from "@llm4ts/flow/Patterns"
import type { WorkspaceError, WorkspaceShape } from "@llm4ts/flow/Workspace"
import {
  builtinKitsDir,
  discoverKits,
  findPack,
  kitTierPaths,
  type DiscoveredKit,
  type KitTierPaths
} from "./Kits.ts"
import { makeNodeWorkspace } from "./NodeWorkspace.ts"

/**
 * Pack location for the modernization flows. `LLM4TS_PACK` names the pack
 * (default `cobol-springboot`) in one of three forms:
 *
 * - a bare name (`cobol-springboot`) or `kit/pack` (`mainframe-java/cobol-springboot`),
 *   resolved across the kits discovered in the project, global, and built-in
 *   tiers (ADR 0014);
 * - a path relative to the launch directory whose directory holds `pack.md`
 *   (`packs/my-pack`) — a pack still being written, not yet in a kit;
 * - an absolute path to such a directory.
 *
 * The built-in tier is what lets `llm4ts run modernize-survey --repo <estate>`
 * work from any directory instead of only from a checkout.
 */

export class PackNotFound extends Schema.TaggedError<PackNotFound>()("PackNotFound", {
  message: Schema.String
}) {}

export interface LocatedPack {
  /** Directory the pack workspace is rooted at: the kit, or the pack itself. */
  readonly root: string
  /** Pack directory relative to `root` (`"."` for a path-form pack). */
  readonly dir: string
  /** The kit the pack came from; absent for a path-form pack. */
  readonly kit?: DiscoveredKit
}

export type PackLocation =
  | ({ readonly _tag: "Located" } & LocatedPack)
  | { readonly _tag: "Ambiguous"; readonly candidates: ReadonlyArray<string> }
  | { readonly _tag: "Absent" }

const hasManifest = (directory: string): boolean => existsSync(join(directory, "pack.md"))

/** Resolves a pack reference: absolute path, launch-relative path, then kits. */
export const locatePack = (
  reference: string,
  options: { readonly launchDir: string; readonly kits: ReadonlyArray<DiscoveredKit> }
): PackLocation => {
  if (isAbsolute(reference)) {
    return hasManifest(reference)
      ? { _tag: "Located", root: reference, dir: "." }
      : { _tag: "Absent" }
  }
  const launchDir = resolve(options.launchDir)
  if (reference.includes("/") && hasManifest(join(launchDir, reference))) {
    return { _tag: "Located", root: launchDir, dir: reference }
  }
  const lookup = findPack(reference, options.kits)
  switch (lookup._tag) {
    case "Found":
      return {
        _tag: "Located",
        root: lookup.kit.root,
        dir: join("packs", lookup.pack),
        kit: lookup.kit
      }
    case "Ambiguous":
      return lookup
    case "Absent":
      return lookup
  }
}

export interface OpenedPack {
  readonly pack: Pack
  /**
   * Workspace rooted where the pack was found — the kit for a kit pack, the
   * pack directory itself otherwise. Pack-relative paths — prompts,
   * `<pack>/patterns`, `lessons.md`, the scaffold — must resolve through
   * this workspace, not the launch directory's.
   */
  readonly workspace: WorkspaceShape
  /** Pack directory within `workspace`. */
  readonly dir: string
  /** The kit the pack belongs to, when it came from one. */
  readonly kit?: DiscoveredKit
}

export const defaultPackName = "cobol-springboot"

export const openPack = Effect.fn("@llm4ts/runner/Packs.openPack")(function* (options: {
  readonly environment: Readonly<Record<string, string | undefined>>
  /** The directory the flow was launched from (`resolveFlowInput().workspace`). */
  readonly launchDir: string
  /** The directory holding the flow script (`import.meta.dirname`). */
  readonly flowDir: string
  /** Kit tiers to search; defaults to the standard tiers around `launchDir` and `flowDir`. */
  readonly kits?: KitTierPaths
}): Effect.fn.Return<OpenedPack, PackNotFound | WorkspaceError | PlanParseError> {
  const reference = options.environment.LLM4TS_PACK?.trim() || defaultPackName
  const builtinDir = builtinKitsDir(options.flowDir)
  const tiers =
    options.kits ??
    kitTierPaths({
      cwd: options.launchDir,
      homeDir: homedir(),
      environment: options.environment,
      ...(builtinDir === undefined ? {} : { builtinDir })
    })
  const kits = discoverKits(tiers)
  const location = locatePack(reference, { launchDir: options.launchDir, kits })
  if (location._tag === "Ambiguous") {
    return yield* PackNotFound.make({
      message:
        `pack '${reference}' is shipped by more than one kit — ` +
        `name one of: ${location.candidates.join(", ")}`
    })
  }
  if (location._tag === "Absent") {
    const known = kits.flatMap((kit) => kit.packs.map((pack) => `${kit.name}/${pack}`))
    return yield* PackNotFound.make({
      message:
        `pack '${reference}' not found: no kit ships it` +
        (known.length === 0 ? "" : ` (known packs: ${known.join(", ")})`) +
        ` and no ${join(reference, "pack.md")} exists under ${resolve(options.launchDir)} — ` +
        "set LLM4TS_PACK to a kit pack name, a kit/pack name, or a directory holding pack.md"
    })
  }
  const workspace = yield* makeNodeWorkspace(location.root)
  const pack = yield* loadPack(workspace, location.dir)
  return {
    pack,
    workspace,
    dir: location.dir,
    ...(location.kit === undefined ? {} : { kit: location.kit })
  }
})

/**
 * The pattern cards of the kit the opened pack belongs to (`<kit>/patterns`);
 * a path-form pack, or a kit without a deck, contributes none. Pack-local
 * cards (`<pack>/patterns`) are loaded separately by the flows.
 */
export const loadKitPatternCards = Effect.fn("@llm4ts/runner/Packs.loadKitPatternCards")(function* (
  opened: OpenedPack
): Effect.fn.Return<ReadonlyArray<PatternCard>, WorkspaceError> {
  if (opened.kit === undefined || !existsSync(join(opened.kit.root, "patterns"))) {
    return []
  }
  return yield* loadPatternCards(opened.workspace, "patterns")
})
