import * as Effect from "effect/Effect"
import { ToolExecutionFailed, makeTool, type Tool } from "@llm4ts/core/tools/Tool"
import { isJsonRecord } from "@llm4ts/core/providers/CliSupport"
import type { JsonValue } from "@llm4ts/core/providers/CliSupport"
import type { WorkspaceShape } from "./Workspace.ts"

const parameter = (
  parameters: JsonValue,
  name: string
): Effect.Effect<string, ToolExecutionFailed> => {
  if (!isJsonRecord(parameters)) {
    return Effect.fail(
      ToolExecutionFailed.make({
        message: "tool parameters must be an object"
      })
    )
  }
  const value = parameters[name]
  return typeof value === "string"
    ? Effect.succeed(value)
    : Effect.fail(
        ToolExecutionFailed.make({
          message: `parameter '${name}' must be a string`
        })
      )
}

const optionalParameter = (
  parameters: JsonValue,
  name: string
): Effect.Effect<string | undefined, ToolExecutionFailed> => {
  if (!isJsonRecord(parameters)) {
    return Effect.fail(
      ToolExecutionFailed.make({
        message: "tool parameters must be an object"
      })
    )
  }
  const value = parameters[name]
  return value === undefined || typeof value === "string"
    ? Effect.succeed(value)
    : Effect.fail(
        ToolExecutionFailed.make({
          message: `parameter '${name}' must be a string when supplied`
        })
      )
}

const mapWorkspaceError = Effect.mapError((error: { readonly message: string }) =>
  ToolExecutionFailed.make({ message: error.message })
)

const pathSchema = {
  type: "object",
  properties: {
    path: { type: "string" }
  },
  required: ["path"],
  additionalProperties: false
}

const contentSchema = {
  type: "object",
  properties: {
    path: { type: "string" },
    contents: { type: "string" }
  },
  required: ["path", "contents"],
  additionalProperties: false
}

export const workspaceTools = (workspace: WorkspaceShape): ReadonlyArray<Tool> => [
  makeTool({
    name: "workspace_read",
    description: "Read a bounded UTF-8 file under the workspace root",
    parameters: pathSchema,
    tags: ["file", "read", "workspace"],
    sandbox: "WorkspaceReadOnly",
    execute: (parameters) =>
      Effect.all({
        path: parameter(parameters, "path")
      }).pipe(
        Effect.flatMap(({ path }) => workspace.read(path)),
        mapWorkspaceError
      )
  }),
  makeTool({
    name: "workspace_write",
    description: "Write bounded UTF-8 content under the workspace root",
    parameters: contentSchema,
    tags: ["file", "write", "workspace"],
    execute: (parameters) =>
      Effect.all({
        path: parameter(parameters, "path"),
        contents: parameter(parameters, "contents")
      }).pipe(
        Effect.flatMap(({ path, contents }) => workspace.write(path, contents)),
        mapWorkspaceError,
        Effect.as({ written: true })
      )
  }),
  makeTool({
    name: "workspace_append",
    description: "Append bounded UTF-8 content under the workspace root",
    parameters: contentSchema,
    tags: ["file", "append", "workspace"],
    execute: (parameters) =>
      Effect.all({
        path: parameter(parameters, "path"),
        contents: parameter(parameters, "contents")
      }).pipe(
        Effect.flatMap(({ path, contents }) => workspace.append(path, contents)),
        mapWorkspaceError,
        Effect.as({ appended: true })
      )
  }),
  makeTool({
    name: "workspace_discover",
    description: "Discover files under the workspace root using a bounded glob",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" }
      },
      additionalProperties: false
    },
    tags: ["file", "glob", "discover", "workspace"],
    sandbox: "WorkspaceReadOnly",
    execute: (parameters) =>
      optionalParameter(parameters, "pattern").pipe(
        Effect.flatMap((pattern) => workspace.discover(pattern)),
        mapWorkspaceError,
        Effect.map((paths) => [...paths])
      )
  }),
  makeTool({
    name: "workspace_search",
    description: "Search bounded workspace files for literal text",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        pattern: { type: "string" }
      },
      required: ["query"],
      additionalProperties: false
    },
    tags: ["file", "search", "workspace"],
    sandbox: "WorkspaceReadOnly",
    execute: (parameters) =>
      Effect.all({
        query: parameter(parameters, "query"),
        pattern: optionalParameter(parameters, "pattern")
      }).pipe(
        Effect.flatMap(({ pattern, query }) => workspace.search(query, pattern)),
        mapWorkspaceError,
        Effect.map((matches) =>
          matches.map((match) => ({
            path: match.path,
            line: match.line,
            text: match.text
          }))
        )
      )
  }),
  makeTool({
    name: "workspace_validate_json",
    description: "Validate that a bounded workspace file contains JSON",
    parameters: pathSchema,
    tags: ["file", "validate", "json", "workspace"],
    sandbox: "WorkspaceReadOnly",
    execute: (parameters) =>
      parameter(parameters, "path").pipe(
        Effect.flatMap((path) => workspace.read(path)),
        mapWorkspaceError,
        Effect.flatMap((contents) =>
          Effect.try({
            try: () => JSON.parse(contents),
            catch: (error) =>
              ToolExecutionFailed.make({
                message: `invalid JSON: ${String(error)}`
              })
          })
        ),
        Effect.as({ valid: true })
      )
  })
]
