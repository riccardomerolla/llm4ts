import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
  appendFile
} from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import {
  SearchMatch,
  Workspace,
  defaultWorkspaceLimits,
  type WorkspaceError,
  type WorkspaceLimits,
  type WorkspaceShape
} from "@llm4ts/flow/Workspace"
import { WorkspaceIoError, WorkspaceLimitError, WorkspacePathError } from "@llm4ts/flow/FlowError"

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const isMissing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT"

const contains = (root: string, target: string): boolean => {
  const path = relative(root, target)
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))
}

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

const nearestExistingParent = async (path: string): Promise<string> => {
  let current = path
  while (true) {
    try {
      await lstat(current)
      return current
    } catch (error) {
      if (!isMissing(error)) {
        throw error
      }
      const parent = dirname(current)
      if (parent === current) {
        throw error
      }
      current = parent
    }
  }
}

export const makeNodeWorkspace = Effect.fn("@llm4ts/runner/NodeWorkspace.make")(function* (
  configuredRoot: string,
  limits: WorkspaceLimits = defaultWorkspaceLimits
): Effect.fn.Return<WorkspaceShape, WorkspaceError> {
  const root = yield* Effect.tryPromise({
    try: () => realpath(resolve(configuredRoot)),
    catch: (error) =>
      WorkspaceIoError.make({
        operation: "open workspace",
        path: configuredRoot,
        message: errorMessage(error),
        cause: error
      })
  })

  const resolveSafe = (input: string): Effect.Effect<string, WorkspaceError> =>
    Effect.tryPromise({
      try: async () => {
        const lexical = resolve(root, input)
        if (!contains(root, lexical)) {
          throw WorkspacePathError.make({
            path: input,
            message: "path escapes the configured workspace"
          })
        }
        const existing = await nearestExistingParent(lexical)
        const physical = await realpath(existing)
        if (!contains(root, physical)) {
          throw WorkspacePathError.make({
            path: input,
            message: "path resolves through a symlink outside the configured workspace"
          })
        }
        return lexical
      },
      catch: (error) =>
        error instanceof WorkspacePathError
          ? error
          : WorkspaceIoError.make({
              operation: "resolve",
              path: input,
              message: errorMessage(error),
              cause: error
            })
    })

  const read = Effect.fn("@llm4ts/runner/NodeWorkspace.read")(function* (
    input: string
  ): Effect.fn.Return<string, WorkspaceError> {
    const path = yield* resolveSafe(input)
    const info = yield* Effect.tryPromise({
      try: () => stat(path),
      catch: (error) =>
        WorkspaceIoError.make({
          operation: "read",
          path: input,
          message: errorMessage(error),
          cause: error
        })
    })
    if (info.size > limits.maxReadBytes) {
      return yield* WorkspaceLimitError.make({
        operation: "read bytes",
        limit: limits.maxReadBytes,
        actual: info.size
      })
    }
    return yield* Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: (error) =>
        WorkspaceIoError.make({
          operation: "read",
          path: input,
          message: errorMessage(error),
          cause: error
        })
    })
  })

  const writeBounded = (
    operation: "write" | "append",
    input: string,
    contents: string
  ): Effect.Effect<void, WorkspaceError> =>
    Effect.gen(function* () {
      const bytes = Buffer.byteLength(contents)
      if (bytes > limits.maxWriteBytes) {
        return yield* WorkspaceLimitError.make({
          operation: `${operation} bytes`,
          limit: limits.maxWriteBytes,
          actual: bytes
        })
      }
      const path = yield* resolveSafe(input)
      yield* Effect.tryPromise({
        try: async () => {
          await mkdir(dirname(path), { recursive: true })
          if (operation === "write") {
            await writeFile(path, contents, "utf8")
          } else {
            await appendFile(path, contents, "utf8")
          }
        },
        catch: (error) =>
          WorkspaceIoError.make({
            operation,
            path: input,
            message: errorMessage(error),
            cause: error
          })
      })
    })

  const discover = (pattern = "**/*"): Effect.Effect<ReadonlyArray<string>, WorkspaceError> =>
    Effect.tryPromise({
      try: async () => {
        const normalizedPattern = pattern.replaceAll("\\", "/")
        const matcher = normalizedPattern === "**/*" ? /.*/ : globRegex(normalizedPattern)
        const results: Array<string> = []
        const walk = async (directory: string, depth: number): Promise<void> => {
          if (depth > limits.maxDepth) {
            throw WorkspaceLimitError.make({
              operation: "discovery depth",
              limit: limits.maxDepth,
              actual: depth
            })
          }
          const entries = await readdir(directory, { withFileTypes: true })
          entries.sort((left, right) => left.name.localeCompare(right.name))
          for (const entry of entries) {
            if (entry.isSymbolicLink()) {
              continue
            }
            const absolute = resolve(directory, entry.name)
            const path = relative(root, absolute).split(sep).join("/")
            if (entry.isDirectory()) {
              await walk(absolute, depth + 1)
            } else if (entry.isFile() && matcher.test(path)) {
              results.push(path)
              if (results.length > limits.maxResults) {
                throw WorkspaceLimitError.make({
                  operation: "discovery results",
                  limit: limits.maxResults,
                  actual: results.length
                })
              }
            }
          }
        }
        await walk(root, 0)
        return results
      },
      catch: (error) =>
        error instanceof WorkspaceLimitError
          ? error
          : WorkspaceIoError.make({
              operation: "discover",
              path: root,
              message: errorMessage(error),
              cause: error
            })
    })

  const search = Effect.fn("@llm4ts/runner/NodeWorkspace.search")(function* (
    query: string,
    pattern = "**/*"
  ): Effect.fn.Return<ReadonlyArray<SearchMatch>, WorkspaceError> {
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
    resolve: resolveSafe,
    read,
    write: (path, contents) => writeBounded("write", path, contents),
    append: (path, contents) => writeBounded("append", path, contents),
    discover,
    search
  }
})

export const NodeWorkspaceLive = (
  root: string,
  limits: WorkspaceLimits = defaultWorkspaceLimits
): Layer.Layer<Workspace, WorkspaceError> =>
  Layer.effect(Workspace, makeNodeWorkspace(root, limits))
