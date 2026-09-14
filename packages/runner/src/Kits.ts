import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

/**
 * A kit is a directory bundling everything stack-specific the engine flows
 * consume: `packs/<name>/pack.md` manifests, the `scaffolds/` they point at,
 * a `patterns/` deck of translation cards, optional `flows/` of its own, and
 * a `README.md` whose first paragraph is the kit's description (ADR 0014).
 * Kits are discovered in the same three tiers as flows — the project's
 * `.llm4ts/kits/`, the global `~/.config/llm4ts/kits/`, and the built-in
 * kits shipped beside the engine flows — with project > global > builtin
 * precedence by kit name.
 */
export type KitTier = "project" | "global" | "builtin"

export interface KitTierPaths {
  readonly project?: string
  readonly global?: string
  readonly builtin?: string
}

export interface DiscoveredKit {
  readonly name: string
  /** Absolute kit directory. */
  readonly root: string
  readonly tier: KitTier
  readonly description?: string
  /** Pack names: every `packs/<name>/pack.md`. */
  readonly packs: ReadonlyArray<string>
  /** Flow names: every `flows/<name>.ts|js` (not `lib/` or `test/`). */
  readonly flows: ReadonlyArray<string>
  readonly shadows: ReadonlyArray<KitTier>
}

const tierOrder: ReadonlyArray<KitTier> = ["project", "global", "builtin"]

export const kitTierPaths = (options: {
  readonly cwd: string
  readonly homeDir: string
  readonly environment?: Readonly<Record<string, string | undefined>>
  readonly builtinDir?: string
}): KitTierPaths => {
  const environment = options.environment ?? process.env
  const configHome =
    environment.XDG_CONFIG_HOME !== undefined && environment.XDG_CONFIG_HOME.length > 0
      ? environment.XDG_CONFIG_HOME
      : join(options.homeDir, ".config")
  return {
    project: join(options.cwd, ".llm4ts", "kits"),
    global: join(configHome, "llm4ts", "kits"),
    ...(options.builtinDir === undefined ? {} : { builtin: options.builtinDir })
  }
}

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * The built-in kits directory for a flow script: the `kits/` directory that
 * sits beside the engine `flows/` — in a checkout `<repo>/kits`, in the
 * published shell `<shell>/kits` — found by walking up from the flow's own
 * directory. A kit's own flows live two levels deeper and resolve the same
 * way. `undefined` when no `kits/` directory is within reach.
 */
export const builtinKitsDir = (flowDir: string): string | undefined => {
  let directory = resolve(flowDir)
  for (let depth = 0; depth < 4; depth += 1) {
    const candidate = join(directory, "kits")
    if (isDirectory(candidate)) {
      return candidate
    }
    const parent = dirname(directory)
    if (parent === directory) {
      break
    }
    directory = parent
  }
  return undefined
}

/** The first non-empty line after the README's `# ` title, without markup. */
export const parseKitDescription = (readme: string): string | undefined => {
  const lines = readme.split(/\r?\n/)
  const start = lines.findIndex((line) => line.startsWith("# "))
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim()
    if (trimmed.length > 0 && !trimmed.startsWith("#")) {
      return trimmed
    }
  }
  return undefined
}

const listDirectories = (path: string): ReadonlyArray<string> =>
  isDirectory(path)
    ? readdirSync(path)
        .filter((entry) => isDirectory(join(path, entry)))
        .sort()
    : []

const readKit = (
  name: string,
  root: string,
  tier: KitTier
): Omit<DiscoveredKit, "shadows"> | undefined => {
  const packs = listDirectories(join(root, "packs")).filter((pack) =>
    existsSync(join(root, "packs", pack, "pack.md"))
  )
  const flowsDir = join(root, "flows")
  const flows = isDirectory(flowsDir)
    ? readdirSync(flowsDir)
        .filter((entry) => entry.endsWith(".ts") || entry.endsWith(".js"))
        .map((entry) => entry.replace(/\.(ts|js)$/, ""))
        .sort()
    : []
  if (packs.length === 0 && flows.length === 0) {
    return undefined
  }
  const readme = join(root, "README.md")
  const description = existsSync(readme)
    ? parseKitDescription(readFileSync(readme, "utf8"))
    : undefined
  return {
    name,
    root,
    tier,
    ...(description === undefined ? {} : { description }),
    packs,
    flows
  }
}

/**
 * Discovers kits across the tiers. A directory is a kit when it holds at
 * least one pack or one flow; missing tier directories contribute nothing.
 */
export const discoverKits = (paths: KitTierPaths): ReadonlyArray<DiscoveredKit> => {
  const byName = new Map<string, { kit: Omit<DiscoveredKit, "shadows">; shadows: Array<KitTier> }>()
  for (const tier of tierOrder) {
    const directory = paths[tier]
    if (directory === undefined) {
      continue
    }
    for (const name of listDirectories(directory)) {
      const kit = readKit(name, join(resolve(directory), name), tier)
      if (kit === undefined) {
        continue
      }
      const existing = byName.get(name)
      if (existing === undefined) {
        byName.set(name, { kit, shadows: [] })
      } else {
        existing.shadows.push(tier)
      }
    }
  }
  return [...byName.values()]
    .map(({ kit, shadows }): DiscoveredKit => ({ ...kit, shadows }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

export type PackLookup =
  | { readonly _tag: "Found"; readonly kit: DiscoveredKit; readonly pack: string }
  | { readonly _tag: "Ambiguous"; readonly candidates: ReadonlyArray<string> }
  | { readonly _tag: "Absent" }

/**
 * Resolves a pack name across discovered kits. `kit/pack` names one kit;
 * a bare name is searched tier by tier (project, then global, then builtin)
 * and is ambiguous only when two kits of the SAME tier both ship it — a
 * project kit shadows a built-in one, exactly as flows do.
 */
export const findPack = (reference: string, kits: ReadonlyArray<DiscoveredKit>): PackLookup => {
  const slash = reference.indexOf("/")
  if (slash > 0 && reference.indexOf("/", slash + 1) < 0) {
    const kitName = reference.slice(0, slash)
    const pack = reference.slice(slash + 1)
    const kit = kits.find((candidate) => candidate.name === kitName)
    return kit !== undefined && kit.packs.includes(pack)
      ? { _tag: "Found", kit, pack }
      : { _tag: "Absent" }
  }
  for (const tier of tierOrder) {
    const holders = kits.filter((kit) => kit.tier === tier && kit.packs.includes(reference))
    if (holders.length === 1) {
      return { _tag: "Found", kit: holders[0]!, pack: reference }
    }
    if (holders.length > 1) {
      return { _tag: "Ambiguous", candidates: holders.map((kit) => `${kit.name}/${reference}`) }
    }
  }
  return { _tag: "Absent" }
}
