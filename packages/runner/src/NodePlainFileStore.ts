import { createHash, randomUUID } from "node:crypto"
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { PlainFileStore, type PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import { PersistenceError } from "@llm4ts/flow/FlowError"

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const persistenceFailure =
  (operation: string, path: string) =>
  (error: unknown): PersistenceError =>
    PersistenceError.make({
      message: `failed to ${operation} ${path}: ${message(error)}`,
      cause: error
    })

const ensureParent = async (path: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
}

export const nodePlainFileStore: PlainFileStoreShape = {
  read: (path) =>
    Effect.tryPromise({
      try: async () => {
        try {
          return await readFile(path, "utf8")
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return undefined
          }
          throw error
        }
      },
      catch: persistenceFailure("read", path)
    }),
  writeAtomic: (path, contents) =>
    Effect.tryPromise({
      try: async () => {
        await ensureParent(path)
        const temporary = join(dirname(path), `.${randomUUID()}.llm4ts-tmp`)
        try {
          await writeFile(temporary, contents, "utf8")
          await rename(temporary, path)
        } finally {
          await rm(temporary, { force: true })
        }
      },
      catch: persistenceFailure("write", path)
    }),
  append: (path, contents) =>
    Effect.tryPromise({
      try: async () => {
        await ensureParent(path)
        await appendFile(path, contents, "utf8")
      },
      catch: persistenceFailure("append", path)
    }),
  remove: (path) =>
    Effect.tryPromise({
      try: () => rm(path, { force: true }),
      catch: persistenceFailure("remove", path)
    }),
  hashSha256: (path) =>
    Effect.tryPromise({
      try: async () =>
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      catch: persistenceFailure("hash", path)
    })
}

export const NodePlainFileStoreLive = Layer.succeed(PlainFileStore)(nodePlainFileStore)
