// The repository as a planner and a coder should see it before they look:
// a deterministic digest of the tracked files — folders with their counts,
// small folders in full, the package scripts, where the tests live. No model
// call, computed once per epic, so every story stops rediscovering the
// layout with `ls`, `find` and `grep` round trips.
import { cap } from "./Context.ts"

export interface OrientationInput {
  /** Tracked files, repo-relative, as `git ls-files` prints them. */
  readonly files: ReadonlyArray<string>
  /** The application's `package.json` text, when there is one. */
  readonly packageJson?: string
  /** Where the application lives: `.` for the repository root, else a subfolder. */
  readonly appDir?: string
  /** Characters the digest may take; `<= 0` leaves it out. */
  readonly budget: number
}

export const defaultOrientationChars = 8_000

/** Folders never worth a coder's attention: dependencies, build output, llm4ts state. */
const noiseDirs = new Set(["node_modules", "dist", "build", "out", "coverage", ".git", ".llm4ts"])
const noiseFiles = new Set(["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lockb"])

/** Folders deeper than this are summarised by their count. */
const maxDepth = 3
/** A folder with this many files or fewer is listed in full. */
const smallFolder = 12
const testFile = /\.(test|spec)\.[cm]?[jt]sx?$/u

interface Folder {
  readonly path: string
  files: number
  readonly children: Map<string, Folder>
  readonly own: Array<string>
}

const folderOf = (path: string): Folder => ({ path, files: 0, children: new Map(), own: [] })

const isNoise = (file: string): boolean => {
  const parts = file.split("/")
  return parts.some((part) => noiseDirs.has(part)) || noiseFiles.has(parts.at(-1) ?? "")
}

const treeOf = (files: ReadonlyArray<string>): Folder => {
  const root = folderOf("")
  for (const file of files) {
    const parts = file.split("/").filter((part) => part.length > 0)
    let folder = root
    folder.files += 1
    for (const part of parts.slice(0, -1)) {
      let child = folder.children.get(part)
      if (child === undefined) {
        child = folderOf(folder.path.length === 0 ? part : `${folder.path}/${part}`)
        folder.children.set(part, child)
      }
      child.files += 1
      folder = child
    }
    folder.own.push(file)
  }
  return root
}

const sortedChildren = (folder: Folder): ReadonlyArray<Folder> =>
  [...folder.children.values()].sort((left, right) => left.path.localeCompare(right.path))

const folderLine = (folder: Folder, depth: number): string =>
  `${"  ".repeat(depth)}${folder.path}/ (${folder.files} ${folder.files === 1 ? "file" : "files"})`

/** A small folder in full: its own files, then every subfolder the same way. */
const expanded = (folder: Folder, depth: number): ReadonlyArray<string> => [
  ...[...folder.own].sort().map((file) => `${"  ".repeat(depth)}${file}`),
  ...sortedChildren(folder).flatMap((child) => [
    folderLine(child, depth),
    ...expanded(child, depth + 1)
  ])
]

/**
 * The layout: every folder with its count; a folder of `smallFolder` files or
 * fewer listed in full, a larger one descended into up to `maxDepth`.
 */
const layoutLines = (folder: Folder, depth: number): ReadonlyArray<string> =>
  sortedChildren(folder).flatMap((child) => {
    if (child.files <= smallFolder) {
      return [folderLine(child, depth), ...expanded(child, depth + 1)]
    }
    const own =
      child.own.length <= smallFolder
        ? [...child.own].sort().map((file) => `${"  ".repeat(depth + 1)}${file}`)
        : []
    return [
      folderLine(child, depth),
      ...own,
      ...(depth + 1 < maxDepth ? layoutLines(child, depth + 1) : [])
    ]
  })

const scriptsLine = (packageJson: string | undefined): string | undefined => {
  if (packageJson === undefined) {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(packageJson)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null || !("scripts" in parsed)) {
    return undefined
  }
  const scripts = parsed.scripts
  if (typeof scripts !== "object" || scripts === null) {
    return undefined
  }
  const entries = Object.entries(scripts).flatMap(([name, command]) =>
    typeof command === "string" ? [`${name}: ${cap(command, 80).text}`] : []
  )
  return entries.length === 0 ? undefined : `Scripts (package.json): ${entries.join("; ")}`
}

const testsLine = (files: ReadonlyArray<string>): string | undefined => {
  const counts = new Map<string, number>()
  for (const file of files) {
    if (testFile.test(file) || file.includes("/__tests__/")) {
      const folder = file.split("/").slice(0, -1).join("/") || "."
      counts.set(folder, (counts.get(folder) ?? 0) + 1)
    }
  }
  if (counts.size === 0) {
    return undefined
  }
  const shown = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 8)
    .map(([folder, count]) => `${folder} (${count})`)
  const more = counts.size - shown.length
  return `Tests live beside the code in: ${shown.join(", ")}${more > 0 ? ` and ${more} more folder(s)` : ""}`
}

/**
 * The digest, or `undefined` when there is nothing to say (no tracked files)
 * or no budget. Never longer than `budget`: the head (the layout) and the
 * tail (scripts, tests) survive a cut, the middle of a long listing does not.
 */
export const orientationOf = (input: OrientationInput): string | undefined => {
  if (input.budget <= 0) {
    return undefined
  }
  const files = input.files.filter((file) => !isNoise(file))
  if (files.length === 0) {
    return undefined
  }
  const root = treeOf(files)
  const appDir = input.appDir ?? "."
  const text = [
    "## Repository orientation",
    "Tracked files by folder (counts; small folders listed in full) — go straight to the right",
    "place instead of listing directories or searching for where things live.",
    ...(appDir === "."
      ? []
      : [`The application lives in ${appDir}/ — its package.json, sources and tests.`]),
    "",
    ...[...root.own].sort(),
    ...layoutLines(root, 0),
    ...[scriptsLine(input.packageJson), testsLine(files)].flatMap((line) =>
      line === undefined ? [] : ["", line]
    )
  ].join("\n")
  return cap(text, input.budget).text
}

/**
 * LLM4TS_ORIENTATION_CHARS: how much of the repository digest the planner and
 * every coder see (0 leaves it out); the default otherwise.
 */
export const orientationChars = (
  environment: Readonly<Record<string, string | undefined>>
): { readonly orientationChars?: number } => {
  const raw = environment.LLM4TS_ORIENTATION_CHARS
  const value = Number(raw?.trim() ?? "")
  return raw === undefined || !Number.isInteger(value) || value < 0
    ? {}
    : { orientationChars: value }
}
