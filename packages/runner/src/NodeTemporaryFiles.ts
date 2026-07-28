import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { TemporaryFiles, type TemporaryFilesShape } from "@llm4ts/core/TemporaryFiles"
import { ProviderError } from "@llm4ts/core/Errors"

interface TemporaryFile {
  readonly directory: string
  readonly path: string
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export const nodeTemporaryFiles: TemporaryFilesShape = {
  write: (prefix, suffix, contents) =>
    Effect.acquireRelease(
      Effect.tryPromise({
        try: async (): Promise<TemporaryFile> => {
          const directory = await mkdtemp(join(tmpdir(), prefix))
          const path = join(directory, `value${suffix}`)
          await writeFile(path, contents, "utf8")
          return {
            directory,
            path
          }
        },
        catch: (error) =>
          ProviderError.make({
            message: `Failed to create temporary file: ${errorMessage(error)}`,
            cause: error
          })
      }),
      ({ directory }) =>
        Effect.promise(() =>
          rm(directory, {
            recursive: true,
            force: true
          })
        ).pipe(Effect.catchCause(() => Effect.void))
    ).pipe(Effect.map(({ path }) => path))
}

export const NodeTemporaryFilesLive = Layer.succeed(TemporaryFiles, nodeTemporaryFiles)
