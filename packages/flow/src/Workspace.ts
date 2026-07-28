import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { WorkspaceIoError, WorkspaceLimitError, WorkspacePathError } from "./FlowError.ts"

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
