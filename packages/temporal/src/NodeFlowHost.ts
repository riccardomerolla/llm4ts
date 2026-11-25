import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import * as Effect from "effect/Effect"
import { controlRoot } from "@llm4ts/runner/CheckoutState"
import { nodePlainFileStore } from "@llm4ts/runner/NodePlainFileStore"
import { nodeWriterLock, nodeWriterLockHost, writerLockPath } from "@llm4ts/runner/NodeWriterLock"
import { LaunchError, type FlowHost } from "./FlowHost.ts"

/**
 * The `llm4ts` command line of the installed `@llm4ts/shell`. The package is
 * reached through its bin only (ADR 0050): the flow it starts holds the
 * writer lock, kills its own children and exits non-zero when it fails, the
 * same as a run started from a terminal.
 */
export const installedCli = (): string => {
  const manifest = createRequire(import.meta.url).resolve("@llm4ts/shell/package.json")
  return join(dirname(manifest), "dist", "cli-main.js")
}

const signal = (target: number, name: NodeJS.Signals): void => {
  try {
    process.kill(target, name)
  } catch {
    // already gone
  }
}

/** The process group a detached child leads; the process itself where groups do not exist. */
const groupOf = (pid: number): number => (process.platform === "win32" ? pid : -pid)

export interface NodeFlowHostOptions {
  /** The script `node` runs; default the installed `@llm4ts/shell` bin. */
  readonly cli?: string
  /** Default `process.env`. */
  readonly environment?: Readonly<Record<string, string | undefined>>
}

export const makeNodeFlowHost = (options: NodeFlowHostOptions = {}): FlowHost => {
  const environment = options.environment ?? process.env
  return {
    environment,
    files: nodePlainFileStore,
    start: (request) =>
      Effect.callback((resume) => {
        const cli = options.cli ?? installedCli()
        const child = spawn(process.execPath, [cli, ...request.args], {
          cwd: request.cwd,
          env: request.environment,
          stdio: "ignore",
          // Its own process group: a cancellation ends the flow and
          // everything below it with one signal.
          detached: process.platform !== "win32"
        })
        const exited = Effect.callback<{ code?: number; signal?: string }>((done) => {
          const finish = (code: number | null, by: NodeJS.Signals | null): void => {
            done(
              Effect.succeed({
                ...(code === null ? {} : { code }),
                ...(by === null ? {} : { signal: by })
              })
            )
          }
          if (child.exitCode !== null || child.signalCode !== null) {
            finish(child.exitCode, child.signalCode)
          } else {
            child.once("exit", finish)
          }
        })
        child.once("error", (error) => {
          resume(
            Effect.fail(LaunchError.make({ message: `llm4ts did not start: ${error.message}` }))
          )
        })
        child.once("spawn", () => {
          const pid = child.pid
          resume(
            pid === undefined
              ? Effect.fail(LaunchError.make({ message: "llm4ts started without a pid" }))
              : Effect.succeed({ pid, exited })
          )
        })
      }),
    isAlive: nodeWriterLockHost.isAlive,
    // The whole group, as a terminal's Ctrl-C does: `llm4ts run` leaves the
    // interrupt to the flow process it started, which shares its group.
    interrupt: (pid) => Effect.sync(() => signal(groupOf(pid), "SIGINT")),
    killGroup: (pid) => Effect.sync(() => signal(groupOf(pid), "SIGKILL")),
    holder: (repo) => nodeWriterLock.holder(writerLockPath(environment, repo)),
    controlRoot: (repo) => controlRoot(environment, repo)
  }
}
