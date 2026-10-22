import { spawn } from "node:child_process"
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"

export class FlowLaunchError extends Schema.TaggedError<FlowLaunchError>()("FlowLaunch", {
  message: Schema.String
}) {}

/**
 * True when the flow script cannot resolve `@llm4ts/runner` from its own
 * location — a global flow, a built-in copy, or a bare repository. Project
 * flows inside a repository that installs `@llm4ts/*` resolve their own pin
 * and need no help (the project-wins policy of ADR 0006). Implemented as the
 * same `node_modules` directory walk ESM resolution performs, so the check
 * stays honest under test runners that patch the module system.
 */
export const needsResolveFallback = (flowPath: string): boolean => {
  let directory = dirname(resolve(flowPath))
  while (true) {
    if (existsSync(join(directory, "node_modules", "@llm4ts", "runner", "package.json"))) {
      return false
    }
    const parent = dirname(directory)
    if (parent === directory) {
      return true
    }
    directory = parent
  }
}

// In the published package the hook is the compiled sibling; when running
// from src (tests), it is the TypeScript source, which the child can load
// because it always runs with type stripping enabled.
const resolveFallbackUrl = (() => {
  const compiled = new URL("./ResolveFallback.js", import.meta.url)
  return existsSync(fileURLToPath(compiled))
    ? compiled.href
    : new URL("./ResolveFallback.ts", import.meta.url).href
})()

export interface FlowProcessStart {
  readonly flowPath: string
  readonly args: ReadonlyArray<string>
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly cwd?: string
  /**
   * File paths are opened for append by the Node implementation. `ignore`
   * discards both streams (used by the terminal launcher's tests).
   */
  readonly stdio: "inherit" | "ignore" | { readonly stdout: string; readonly stderr: string }
  /**
   * Runs the child in its own process group, so a Ctrl-C on the parent's
   * terminal or a whole-group kill reaches only the parent, which then stops
   * the child once. The terminal launcher leaves it off: there the
   * terminal's SIGINT must keep reaching the child.
   */
  readonly detached?: boolean
}

export interface FlowProcessExit {
  readonly code: number | undefined
  readonly signal: string | undefined
}

export interface FlowProcessHandle {
  readonly pid: number
  readonly exited: Effect.Effect<FlowProcessExit>
  readonly signal: (signal: "SIGINT" | "SIGTERM") => Effect.Effect<void>
}

export interface FlowProcessShape {
  readonly start: (options: FlowProcessStart) => Effect.Effect<FlowProcessHandle, FlowLaunchError>
  readonly isAlive: (pid: number) => boolean
  /** Signals a process this shape did not start (a run left by an earlier server). */
  readonly signal: (pid: number, signal: "SIGINT" | "SIGTERM") => Effect.Effect<void>
}

export const flowNodeArgs = (flowPath: string): ReadonlyArray<string> => [
  "--experimental-strip-types",
  ...(needsResolveFallback(flowPath) ? ["--import", resolveFallbackUrl] : [])
]

const openAppend = (path: string): number => {
  mkdirSync(dirname(path), { recursive: true })
  return openSync(path, "a")
}

export const nodeFlowProcess: FlowProcessShape = {
  start: (options) =>
    Effect.callback<FlowProcessHandle, FlowLaunchError>((resume) => {
      const exited = Deferred.makeUnsafe<FlowProcessExit>()
      const fds: Array<number> = []
      const closeAll = (): void => {
        for (const fd of fds.splice(0)) {
          try {
            closeSync(fd)
          } catch {
            // already closed
          }
        }
      }
      let stdio: "inherit" | "ignore" | Array<"ignore" | number>
      try {
        if (typeof options.stdio === "string") {
          stdio = options.stdio
        } else {
          const out = openAppend(options.stdio.stdout)
          fds.push(out)
          const err = openAppend(options.stdio.stderr)
          fds.push(err)
          stdio = ["ignore", out, err]
        }
      } catch (error) {
        closeAll()
        resume(
          Effect.fail(
            new FlowLaunchError({ message: error instanceof Error ? error.message : String(error) })
          )
        )
        return Effect.void
      }
      const child = spawn(
        process.execPath,
        [...flowNodeArgs(options.flowPath), options.flowPath, ...options.args],
        {
          stdio,
          env: { ...options.environment },
          ...(options.detached === true ? { detached: true } : {}),
          ...(options.cwd === undefined ? {} : { cwd: options.cwd })
        }
      )
      closeAll()
      let started = false
      child.on("error", (error) => {
        if (!started) {
          resume(Effect.fail(new FlowLaunchError({ message: error.message })))
        }
      })
      child.on("spawn", () => {
        started = true
        resume(
          Effect.succeed({
            pid: child.pid ?? 0,
            exited: Deferred.await(exited),
            signal: (signal) =>
              Effect.sync(() => {
                child.kill(signal)
              })
          })
        )
      })
      child.on("exit", (code, signal) => {
        Deferred.doneUnsafe(
          exited,
          Effect.succeed({ code: code ?? undefined, signal: signal ?? undefined })
        )
      })
      return Effect.void
    }),
  isAlive: (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  },
  signal: (pid, signal) =>
    Effect.sync(() => {
      try {
        process.kill(pid, signal)
      } catch {
        // already gone (ESRCH) or not ours to signal
      }
    })
}

export interface FakeFlowProcess {
  readonly process: FlowProcessShape
  readonly started: Effect.Effect<ReadonlyArray<FlowProcessStart>>
  readonly exit: (pid: number, exit: FlowProcessExit) => Effect.Effect<void>
  readonly signals: Effect.Effect<ReadonlyArray<{ pid: number; signal: string }>>
  readonly setAlive: (pid: number, alive: boolean) => Effect.Effect<void>
}

export const makeFakeFlowProcess = (): Effect.Effect<FakeFlowProcess> =>
  Effect.gen(function* () {
    const starts = yield* Ref.make<ReadonlyArray<FlowProcessStart>>([])
    const signals = yield* Ref.make<ReadonlyArray<{ pid: number; signal: string }>>([])
    const alive = yield* Ref.make<ReadonlySet<number>>(new Set())
    const exits = new Map<number, Deferred.Deferred<FlowProcessExit>>()
    let nextPid = 1000
    const setMember = (pid: number, member: boolean) =>
      Ref.update(alive, (set) => {
        const next = new Set(set)
        if (member) {
          next.add(pid)
        } else {
          next.delete(pid)
        }
        return next
      })
    const process: FlowProcessShape = {
      start: (options) =>
        Effect.gen(function* () {
          const pid = nextPid++
          const exited = yield* Deferred.make<FlowProcessExit>()
          exits.set(pid, exited)
          yield* Ref.update(starts, (all) => [...all, options])
          yield* setMember(pid, true)
          return {
            pid,
            exited: Deferred.await(exited),
            signal: (signal) => Ref.update(signals, (all) => [...all, { pid, signal }])
          }
        }),
      isAlive: (pid) => Ref.getUnsafe(alive).has(pid),
      signal: (pid, signal) => Ref.update(signals, (all) => [...all, { pid, signal }])
    }
    return {
      process,
      started: Ref.get(starts),
      signals: Ref.get(signals),
      exit: (pid, exit) =>
        Effect.gen(function* () {
          yield* setMember(pid, false)
          const deferred = exits.get(pid)
          if (deferred !== undefined) {
            yield* Deferred.succeed(deferred, exit)
          }
        }),
      setAlive: (pid, value) => setMember(pid, value)
    }
  })
