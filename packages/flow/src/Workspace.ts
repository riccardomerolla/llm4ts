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
}

export const defaultWorkspaceLimits: WorkspaceLimits = Object.freeze({
  maxReadBytes: 1_048_576,
  maxWriteBytes: 1_048_576,
  maxResults: 1_000,
  maxDepth: 32
})

export interface WorkspaceShape {
  readonly root: string
  readonly resolve: (path: string) => Effect.Effect<string, WorkspaceError>
  readonly read: (path: string) => Effect.Effect<string, WorkspaceError>
  readonly write: (path: string, contents: string) => Effect.Effect<void, WorkspaceError>
  readonly append: (path: string, contents: string) => Effect.Effect<void, WorkspaceError>
  readonly discover: (pattern?: string) => Effect.Effect<ReadonlyArray<string>, WorkspaceError>
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

      const discover = (pattern = "**/*"): Effect.Effect<ReadonlyArray<string>, WorkspaceError> =>
        Effect.gen(function* () {
          const normalizedPattern = pattern.replaceAll("\\", "/")
          const matcher = normalizedPattern === "**/*" ? /.*/ : globRegex(normalizedPattern)
          const files = yield* Ref.get(state)
          const results: Array<string> = []
          for (const path of Object.keys(files).sort(comparePaths)) {
            const depth = path.split("/").length - 1
            if (depth > limits.maxDepth) {
              return yield* WorkspaceLimitError.make({
                operation: "discovery depth",
                limit: limits.maxDepth,
                actual: depth
              })
            }
            if (matcher.test(path)) {
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
