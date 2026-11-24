import { randomBytes } from "node:crypto"
import { linkSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import * as Effect from "effect/Effect"
import { PersistenceError } from "@llm4ts/flow/FlowError"
import { makeWriterLock, type WriterLockHost, type WriterLockShape } from "@llm4ts/flow/WriterLock"
import { checkoutKey, stateHome } from "./CheckoutState.ts"
import { nodePlainFileStore } from "./NodePlainFileStore.ts"

type Environment = Readonly<Record<string, string | undefined>>

/**
 * A checkout's lock file (ADR 0058):
 * `${XDG_STATE_HOME:-~/.local/state}/llm4ts/locks/<name>-<8 hex>.json`, the
 * hex from the SHA-256 of the checkout's real path. Outside the checkout,
 * where a coder cannot delete it.
 */
export const writerLockPath = (environment: Environment, workDir: string): string =>
  join(stateHome(environment), "locks", `${checkoutKey(workDir)}.json`)

// A signal 0 that fails with EPERM found a process it may not signal: alive.
const signalable = (target: number): boolean => {
  try {
    process.kill(target, 0)
    return true
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM"
  }
}

export const nodeWriterLockHost: WriterLockHost = {
  files: nodePlainFileStore,
  // A hard link appears whole or not at all, so a reader never sees a file
  // that exists but is still empty.
  createExclusive: (path, contents) =>
    Effect.try({
      try: () => {
        mkdirSync(dirname(path), { recursive: true })
        const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
        writeFileSync(temporary, contents)
        try {
          linkSync(temporary, path)
          return true
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "EEXIST") return false
          throw error
        } finally {
          unlinkSync(temporary)
        }
      },
      catch: (error) =>
        PersistenceError.make({
          message: `failed to create ${path}: ${error instanceof Error ? error.message : String(error)}`
        })
    }),
  isAlive: (pid) => pid > 0 && signalable(pid),
  groupAlive: (pgid) => process.platform !== "win32" && pgid > 1 && signalable(-pgid),
  pid: process.pid
}

export const nodeWriterLock: WriterLockShape = makeWriterLock(nodeWriterLockHost)
