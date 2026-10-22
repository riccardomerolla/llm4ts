import { spawnSync } from "node:child_process"
import { constants } from "node:os"
import * as Effect from "effect/Effect"
import { FlowLaunchError, needsResolveFallback, nodeFlowProcess } from "./FlowProcess.ts"

export { FlowLaunchError, needsResolveFallback }

export interface LaunchFlowOptions {
  readonly flowPath: string
  readonly taskArgs: ReadonlyArray<string>
  readonly environment?: Readonly<Record<string, string | undefined>>
  readonly cwd?: string
  /** Overrides `LLM4TS_CODER` in the child for this run only. */
  readonly coder?: string
  /** `inherit` shares the terminal (the default); tests use `ignore`. */
  readonly stdio?: "inherit" | "ignore"
}

/**
 * A flow's live status display turns input echo off and hides the cursor;
 * a flow killed by a signal cannot turn them back on, so the shell does it
 * once the child is gone. Harmless when they were never changed.
 */
const restoreTerminal = (stdio: "inherit" | "ignore"): void => {
  if (stdio !== "inherit" || process.platform === "win32" || process.stdin.isTTY !== true) {
    return
  }
  spawnSync("stty", ["echo"], { stdio: ["inherit", "ignore", "ignore"] })
  if (process.stdout.isTTY === true) {
    process.stdout.write("\u001b[?25h")
  }
}

/**
 * Runs a flow script as a child `node` process with type stripping, the
 * terminal inherited, and the task text appended to argv. While the child
 * runs, SIGINT is ignored in the parent so Ctrl-C reaches the whole
 * foreground process group and the shell survives to resume. Resolves with
 * the child's exit code (`128 + signal` when terminated by a signal).
 */
export const launchFlow = (options: LaunchFlowOptions): Effect.Effect<number, FlowLaunchError> =>
  Effect.gen(function* () {
    const environment = { ...(options.environment ?? process.env) }
    if (options.coder !== undefined) {
      environment.LLM4TS_CODER = options.coder
    }
    const stdio = options.stdio ?? "inherit"
    const ignoreSigint = (): void => {}
    process.on("SIGINT", ignoreSigint)
    const restoreSigint = (): void => {
      process.removeListener("SIGINT", ignoreSigint)
    }
    return yield* Effect.gen(function* () {
      const handle = yield* nodeFlowProcess.start({
        flowPath: options.flowPath,
        args: options.taskArgs,
        environment,
        stdio,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd })
      })
      const exit = yield* handle.exited.pipe(Effect.onInterrupt(() => handle.signal("SIGINT")))
      restoreTerminal(stdio)
      if (exit.signal !== undefined) {
        const number = Object.entries(constants.signals).find(([name]) => name === exit.signal)
        return 128 + (number?.[1] ?? 15)
      }
      return exit.code ?? 1
    }).pipe(Effect.ensuring(Effect.sync(restoreSigint)))
  })
