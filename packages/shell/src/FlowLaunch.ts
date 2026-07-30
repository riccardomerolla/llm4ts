import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { constants } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

export class FlowLaunchError extends Schema.TaggedErrorClass<FlowLaunchError>()("FlowLaunch", {
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
 * Runs a flow script as a child `node` process with type stripping, the
 * terminal inherited, and the task text appended to argv. While the child
 * runs, SIGINT is ignored in the parent so Ctrl-C reaches the whole
 * foreground process group and the shell survives to resume. Resolves with
 * the child's exit code (`128 + signal` when terminated by a signal).
 */
export const launchFlow = (options: LaunchFlowOptions): Effect.Effect<number, FlowLaunchError> =>
  Effect.callback<number, FlowLaunchError>((resume) => {
    const environment = { ...(options.environment ?? process.env) }
    if (options.coder !== undefined) {
      environment.LLM4TS_CODER = options.coder
    }
    const nodeArgs = ["--experimental-strip-types"]
    if (needsResolveFallback(options.flowPath)) {
      nodeArgs.push("--import", resolveFallbackUrl)
    }
    const child = spawn(process.execPath, [...nodeArgs, options.flowPath, ...options.taskArgs], {
      stdio: options.stdio ?? "inherit",
      env: environment,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd })
    })
    const ignoreSigint = (): void => {}
    process.on("SIGINT", ignoreSigint)
    const restoreSigint = (): void => {
      process.removeListener("SIGINT", ignoreSigint)
    }
    child.on("error", (error) => {
      restoreSigint()
      resume(Effect.fail(new FlowLaunchError({ message: error.message })))
    })
    child.on("exit", (code, signal) => {
      restoreSigint()
      if (signal !== null) {
        resume(Effect.succeed(128 + (constants.signals[signal] ?? 15)))
      } else {
        resume(Effect.succeed(code ?? 1))
      }
    })
    return Effect.sync(() => {
      restoreSigint()
      child.kill("SIGINT")
    })
  })
