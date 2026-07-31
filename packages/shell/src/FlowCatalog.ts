import { join } from "node:path"
import * as Effect from "effect/Effect"
import { FileSystem } from "effect/FileSystem"

export type FlowTier = "project" | "global" | "builtin"

export interface FlowTierPaths {
  readonly project?: string
  readonly global?: string
  readonly builtin?: string
}

export interface DiscoveredFlow {
  readonly name: string
  readonly path: string
  readonly tier: FlowTier
  readonly description?: string
  readonly shadows: ReadonlyArray<FlowTier>
}

/**
 * The first non-empty `//` comment line within the file's leading block of
 * blank lines and `//` comments is the flow's one-line description. A bare or
 * whitespace-only `//` line is skipped, never returned as an empty
 * description; the scan stops at the first line that is neither blank nor a
 * `//` comment.
 */
export const parseFlowDescription = (source: string): string | undefined => {
  for (const line of source.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length === 0) {
      continue
    }
    if (!trimmed.startsWith("//")) {
      return undefined
    }
    const text = trimmed.slice(2).trim()
    if (text.length > 0) {
      return text
    }
  }
  return undefined
}

export const defaultTierPaths = (options: {
  readonly cwd: string
  readonly homeDir: string
  readonly environment?: Readonly<Record<string, string | undefined>>
  readonly builtinDir?: string
}): FlowTierPaths => {
  const environment = options.environment ?? process.env
  const configHome =
    environment.XDG_CONFIG_HOME !== undefined && environment.XDG_CONFIG_HOME.length > 0
      ? environment.XDG_CONFIG_HOME
      : join(options.homeDir, ".config")
  return {
    project: join(options.cwd, ".llm4ts", "flows"),
    global: join(configHome, "llm4ts", "flows"),
    ...(options.builtinDir === undefined ? {} : { builtin: options.builtinDir })
  }
}

const tierOrder: ReadonlyArray<FlowTier> = ["project", "global", "builtin"]

// User-authored flows are .ts (launched with type stripping); the built-in
// tier ships .js because Node refuses to strip types under node_modules.
const flowExtension = (entry: string): string | undefined =>
  entry.endsWith(".ts") ? ".ts" : entry.endsWith(".js") ? ".js" : undefined

const listTier = Effect.fn("@llm4ts/shell/FlowCatalog.listTier")(function* (
  tier: FlowTier,
  directory: string
) {
  const fs = yield* FileSystem
  const entries = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []))
  const flows: Array<Omit<DiscoveredFlow, "shadows">> = []
  for (const entry of [...entries].sort()) {
    const extension = flowExtension(entry)
    if (extension === undefined) {
      continue
    }
    const path = join(directory, entry)
    const source = yield* fs.readFileString(path).pipe(Effect.orElseSucceed(() => ""))
    const description = parseFlowDescription(source)
    flows.push({
      name: entry.slice(0, -extension.length),
      path,
      tier,
      ...(description === undefined ? {} : { description })
    })
  }
  return flows
})

/**
 * Discovers flows across the project, global, and built-in tiers. Precedence
 * is project > global > builtin, keyed by flow name; a shadowed tier is
 * recorded on the winning flow's `shadows` list. Missing or unreadable
 * directories contribute nothing.
 */
export const discoverFlows = Effect.fn("@llm4ts/shell/FlowCatalog.discoverFlows")(function* (
  tiers: FlowTierPaths
) {
  const byName = new Map<
    string,
    { flow: Omit<DiscoveredFlow, "shadows">; shadows: Array<FlowTier> }
  >()
  for (const tier of tierOrder) {
    const directory = tiers[tier]
    if (directory === undefined) {
      continue
    }
    for (const flow of yield* listTier(tier, directory)) {
      const existing = byName.get(flow.name)
      if (existing === undefined) {
        byName.set(flow.name, { flow, shadows: [] })
      } else {
        existing.shadows.push(tier)
      }
    }
  }
  return [...byName.values()]
    .map(({ flow, shadows }): DiscoveredFlow => ({ ...flow, shadows }))
    .sort((left, right) => left.name.localeCompare(right.name))
})
