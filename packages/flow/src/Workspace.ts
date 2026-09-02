import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import { WorkspaceIoError, WorkspaceLimitError, WorkspacePathError } from "./FlowError.ts"

export type WorkspaceError = WorkspacePathError | WorkspaceLimitError | WorkspaceIoError

export class SearchMatch extends Schema.Class<SearchMatch>("SearchMatch")({
  path: Schema.String,
  line: Schema.Int,
  text: Schema.String
}) {}

export interface WorkspaceLimits {
  readonly maxReadBytes: number
  readonly maxWriteBytes: number
  readonly maxResults: number
  readonly maxDepth: number
  /**
   * Directory names discovery never descends into, at any depth. Version
   * control internals and dependency/build output are never estate sources,
   * yet on a real repository they hold the overwhelming majority of files —
   * walking them is slow and used to spend the result cap before the first
   * source was seen. Absent means no pruning (the previous behaviour).
   */
  readonly excludeDirs?: ReadonlyArray<string>
}

/** The directories `defaultWorkspaceLimits` prunes from discovery. */
export const defaultExcludedDirectories: ReadonlyArray<string> = Object.freeze([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "target",
  "build",
  "dist",
  "out"
])

export const defaultWorkspaceLimits: WorkspaceLimits = Object.freeze({
  maxReadBytes: 1_048_576,
  maxWriteBytes: 1_048_576,
  maxResults: 1_000,
  maxDepth: 32,
  excludeDirs: defaultExcludedDirectories
})

/**
 * Limits for workspaces that read raw legacy sources (survey, extract,
 * bench). Legacy estates routinely carry multi-megabyte programs, copybooks,
 * and generated exports, so the default 1 MiB read cap — sized for
 * spec-and-plan repositories — would fail an inventory on its first big
 * file. 8 MiB accommodates real estates while still refusing runaway blobs.
 * The same reasoning sizes the discovery cap: an estate is by nature large,
 * and 1 000 results — sized for spec-and-plan repositories — is fewer files
 * than a mid-sized J2EE application ships in `src/` alone.
 */
export const legacySourceWorkspaceLimits: WorkspaceLimits = Object.freeze({
  ...defaultWorkspaceLimits,
  maxReadBytes: 8_388_608,
  maxResults: 20_000
})

const positiveInteger = (raw: string | undefined): number | undefined => {
  const text = raw?.trim()
  if (text === undefined || text.length === 0 || !/^\d+$/.test(text)) {
    return undefined
  }
  const parsed = Number.parseInt(text, 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

const directoryList = (raw: string | undefined): ReadonlyArray<string> | undefined => {
  const text = raw?.trim()
  if (text === undefined || text.length === 0) {
    return undefined
  }
  const names = text
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0 && !name.includes("/") && !name.includes("\\"))
  return names.length === 0 ? undefined : names
}

/**
 * `defaults` with the caps overridden from the environment when the values
 * are well-formed; anything else leaves that default untouched:
 *
 * - `LLM4TS_MAX_READ_BYTES` (positive integer): the per-file read cap, the
 *   escape hatch for estates whose sources exceed even the legacy-source cap.
 * - `LLM4TS_MAX_DISCOVER_RESULTS` (positive integer): the discovery result
 *   cap, for estates larger than `legacySourceWorkspaceLimits` allows for.
 * - `LLM4TS_EXCLUDE_DIRS` (comma-separated directory names): replaces the
 *   pruned-directory list — `.git,node_modules,generated` — for estates
 *   whose vendored or generated trees sit under names the default list
 *   does not know.
 */
export const workspaceLimitsFromEnv = (
  environment: Readonly<Record<string, string | undefined>>,
  defaults: WorkspaceLimits = defaultWorkspaceLimits
): WorkspaceLimits => {
  const maxReadBytes = positiveInteger(environment.LLM4TS_MAX_READ_BYTES)
  const maxResults = positiveInteger(environment.LLM4TS_MAX_DISCOVER_RESULTS)
  const excludeDirs = directoryList(environment.LLM4TS_EXCLUDE_DIRS)
  if (maxReadBytes === undefined && maxResults === undefined && excludeDirs === undefined) {
    return defaults
  }
  return {
    ...defaults,
    ...(maxReadBytes === undefined ? {} : { maxReadBytes }),
    ...(maxResults === undefined ? {} : { maxResults }),
    ...(excludeDirs === undefined ? {} : { excludeDirs })
  }
}

/**
 * Narrows a discovery beyond its glob: only paths `matching` the first regex
 * and not `excluding` the second are returned AND counted against
 * `maxResults`, so a cap sized for source units is not spent on the jars,
 * images, and generated files that share the tree. Pass regexes without the
 * `g` flag — a global regex carries `lastIndex` state across `test` calls.
 */
export interface DiscoverOptions {
  readonly matching?: RegExp
  readonly excluding?: RegExp
}

export const discoverAccepts = (path: string, options: DiscoverOptions): boolean =>
  (options.matching?.test(path) ?? true) && !(options.excluding?.test(path) ?? false)

/** Whether a repo-relative path lies under a pruned directory. */
export const isExcludedPath = (path: string, limits: WorkspaceLimits): boolean => {
  const excluded = limits.excludeDirs
  if (excluded === undefined || excluded.length === 0) {
    return false
  }
  const directories = path.split("/").slice(0, -1)
  return directories.some((segment) => excluded.includes(segment))
}

/**
 * The advice a flow gives when discovery overflows `limits.maxResults`: the
 * three knobs that narrow or raise it, in the order a user should try them.
 */
export const discoveryOverflowAdvice = (limits: WorkspaceLimits): string => {
  const pruned = limits.excludeDirs ?? []
  return (
    `discovery stopped at ${limits.maxResults} matching files; ` +
    "narrow the pack's `sources:` regex or add an `exclude:` regex, prune more directories " +
    `with LLM4TS_EXCLUDE_DIRS=<names> (pruned now: ${pruned.length === 0 ? "none" : pruned.join(",")}), ` +
    "or raise the cap with LLM4TS_MAX_DISCOVER_RESULTS=<count>"
  )
}

export interface WorkspaceShape {
  readonly root: string
  readonly resolve: (path: string) => Effect.Effect<string, WorkspaceError>
  readonly read: (path: string) => Effect.Effect<string, WorkspaceError>
  readonly write: (path: string, contents: string) => Effect.Effect<void, WorkspaceError>
  readonly append: (path: string, contents: string) => Effect.Effect<void, WorkspaceError>
  readonly discover: (
    pattern?: string,
    options?: DiscoverOptions
  ) => Effect.Effect<ReadonlyArray<string>, WorkspaceError>
  readonly search: (
    query: string,
    pattern?: string
  ) => Effect.Effect<ReadonlyArray<SearchMatch>, WorkspaceError>
}

export class Workspace extends Context.Service<Workspace, WorkspaceShape>()(
  "@llm4ts/flow/Workspace"
) {}

const globRegex = (glob: string): RegExp => {
  let source = ""
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob.charAt(index)
    if (character === "*" && glob.charAt(index + 1) === "*") {
      source += ".*"
      index += 1
    } else if (character === "*") {
      source += "[^/]*"
    } else if (character === "?") {
      source += "[^/]"
    } else {
      source += character.replace(/[\\^$.[\]{}()+|]/g, "\\$&")
    }
  }
  return new RegExp(`^${source}$`)
}

const comparePaths = (left: string, right: string): number => {
  const leftSegments = left.split("/")
  const rightSegments = right.split("/")
  const shared = Math.min(leftSegments.length, rightSegments.length)
  for (let index = 0; index < shared; index += 1) {
    const order = (leftSegments[index] ?? "").localeCompare(rightSegments[index] ?? "")
    if (order !== 0) {
      return order
    }
  }
  return leftSegments.length - rightSegments.length
}

const byteLength = (contents: string): number => new TextEncoder().encode(contents).length

export interface MemoryWorkspaceOptions {
  readonly root?: string
  readonly limits?: WorkspaceLimits
  readonly initial?: Readonly<Record<string, string>>
}

export const makeMemoryWorkspace = (
  options: MemoryWorkspaceOptions = {}
): Effect.Effect<WorkspaceShape> => {
  const root = (options.root ?? "/workspace").replace(/\/+$/, "")
  const limits = options.limits ?? defaultWorkspaceLimits

  const relativeKey = (input: string): string | undefined => {
    const normalized = input.replaceAll("\\", "/")
    const withoutRoot =
      normalized === root
        ? ""
        : normalized.startsWith(`${root}/`)
          ? normalized.slice(root.length + 1)
          : normalized
    if (withoutRoot.startsWith("/")) {
      return undefined
    }
    const segments: Array<string> = []
    for (const part of withoutRoot.split("/")) {
      if (part === "" || part === ".") {
        continue
      }
      if (part === "..") {
        if (segments.length === 0) {
          return undefined
        }
        segments.pop()
      } else {
        segments.push(part)
      }
    }
    return segments.join("/")
  }

  const resolveKey = (input: string): Effect.Effect<string, WorkspaceError> => {
    const key = relativeKey(input)
    return key === undefined
      ? Effect.fail(
          WorkspacePathError.make({
            path: input,
            message: "path escapes the configured workspace"
          })
        )
      : Effect.succeed(key)
  }

  return Ref.make<Readonly<Record<string, string>>>(options.initial ?? {}).pipe(
    Effect.map((state) => {
      const read = (input: string): Effect.Effect<string, WorkspaceError> =>
        Effect.gen(function* () {
          const key = yield* resolveKey(input)
          const files = yield* Ref.get(state)
          const contents = files[key]
          if (contents === undefined) {
            return yield* WorkspaceIoError.make({
              operation: "read",
              path: input,
              message: "file does not exist"
            })
          }
          const bytes = byteLength(contents)
          if (bytes > limits.maxReadBytes) {
            return yield* WorkspaceLimitError.make({
              operation: "read bytes",
              limit: limits.maxReadBytes,
              actual: bytes
            })
          }
          return contents
        })

      const writeBounded = (
        operation: "write" | "append",
        input: string,
        contents: string
      ): Effect.Effect<void, WorkspaceError> => {
        const bytes = byteLength(contents)
        if (bytes > limits.maxWriteBytes) {
          return Effect.fail(
            WorkspaceLimitError.make({
              operation: `${operation} bytes`,
              limit: limits.maxWriteBytes,
              actual: bytes
            })
          )
        }
        return resolveKey(input).pipe(
          Effect.flatMap((key) =>
            Ref.update(state, (files) => ({
              ...files,
              [key]: operation === "write" ? contents : `${files[key] ?? ""}${contents}`
            }))
          )
        )
      }

      const discover = (
        pattern = "**/*",
        options: DiscoverOptions = {}
      ): Effect.Effect<ReadonlyArray<string>, WorkspaceError> =>
        Effect.gen(function* () {
          const normalizedPattern = pattern.replaceAll("\\", "/")
          const matcher = normalizedPattern === "**/*" ? /.*/ : globRegex(normalizedPattern)
          const files = yield* Ref.get(state)
          const results: Array<string> = []
          for (const path of Object.keys(files).sort(comparePaths)) {
            if (isExcludedPath(path, limits)) {
              continue
            }
            const depth = path.split("/").length - 1
            if (depth > limits.maxDepth) {
              return yield* WorkspaceLimitError.make({
                operation: "discovery depth",
                limit: limits.maxDepth,
                actual: depth
              })
            }
            if (matcher.test(path) && discoverAccepts(path, options)) {
              results.push(path)
              if (results.length > limits.maxResults) {
                return yield* WorkspaceLimitError.make({
                  operation: "discovery results",
                  limit: limits.maxResults,
                  actual: results.length
                })
              }
            }
          }
          return results
        })

      const search = (
        query: string,
        pattern = "**/*"
      ): Effect.Effect<ReadonlyArray<SearchMatch>, WorkspaceError> =>
        Effect.gen(function* () {
          const paths = yield* discover(pattern)
          const matches: Array<SearchMatch> = []
          for (const path of paths) {
            const text = yield* read(path)
            const lines = text.split("\n")
            for (let index = 0; index < lines.length; index += 1) {
              const line = lines[index] ?? ""
              if (line.includes(query)) {
                matches.push(
                  SearchMatch.make({
                    path,
                    line: index + 1,
                    text: line
                  })
                )
                if (matches.length > limits.maxResults) {
                  return yield* WorkspaceLimitError.make({
                    operation: "search results",
                    limit: limits.maxResults,
                    actual: matches.length
                  })
                }
              }
            }
          }
          return matches
        })

      return {
        root,
        resolve: (input: string) =>
          resolveKey(input).pipe(Effect.map((key) => (key === "" ? root : `${root}/${key}`))),
        read,
        write: (path: string, contents: string) => writeBounded("write", path, contents),
        append: (path: string, contents: string) => writeBounded("append", path, contents),
        discover,
        search
      }
    })
  )
}
