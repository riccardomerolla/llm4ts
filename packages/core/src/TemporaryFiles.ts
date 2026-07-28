import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import type * as Scope from "effect/Scope"
import type { LlmError } from "./Errors.ts"

export interface TemporaryFilesShape {
  readonly write: (
    prefix: string,
    suffix: string,
    contents: string
  ) => Effect.Effect<string, LlmError, Scope.Scope>
}

export class TemporaryFiles extends Context.Service<TemporaryFiles, TemporaryFilesShape>()(
  "@llm4ts/core/TemporaryFiles"
) {}

export interface FakeTemporaryFiles {
  readonly files: Effect.Effect<
    ReadonlyArray<{
      readonly path: string
      readonly contents: string
    }>
  >
  readonly temporaryFiles: TemporaryFilesShape
}

export const makeFakeTemporaryFiles = (
  path = "/tmp/llm4ts-schema.json"
): Effect.Effect<FakeTemporaryFiles> =>
  Ref.make<
    ReadonlyArray<{
      readonly path: string
      readonly contents: string
    }>
  >([]).pipe(
    Effect.map((files) => ({
      files: Ref.get(files),
      temporaryFiles: {
        write: (_prefix, _suffix, contents) =>
          Ref.update(files, (current) => [
            ...current,
            {
              path,
              contents
            }
          ]).pipe(Effect.as(path))
      }
    }))
  )
