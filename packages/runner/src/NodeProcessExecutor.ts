import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import * as readline from "node:readline"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Queue from "effect/Queue"
import * as Stream from "effect/Stream"
import {
  ProcessExecutor,
  ProcessResult,
  makeProcessExecutor,
  type BidirectionalProcess,
  type ProcessExecutorShape
} from "@llm4ts/core/ProcessExecutor"
import { InvalidRequestError, ProviderError, type LlmError } from "@llm4ts/core/Errors"
import { settingValue } from "@llm4ts/flow/Settings"
import { windowsInvocation } from "./WindowsCommand.ts"

const maxStderrLines = 256
/**
 * Captured mode keeps a process's output in memory to hand it back whole, so
 * a chatty CLI is bounded (review F16): stdout keeps its first lines (the
 * reply a caller parses), stderr its last (where a failure says why). Far
 * above any real reply or gate log; a cut is marked in the output.
 */
const maxCapturedStdoutLines = 200_000
const maxCapturedStderrLines = 10_000

/** `lines` within `limit`, keeping the head or the tail, with a marker for what was dropped. */
const boundedLines = (
  lines: ReadonlyArray<string>,
  dropped: number,
  keep: "head" | "tail"
): ReadonlyArray<string> =>
  dropped === 0
    ? lines
    : keep === "head"
      ? [...lines, `[llm4ts: ${dropped} more line(s) of output not kept]`]
      : [`[llm4ts: ${dropped} earlier line(s) of output not kept]`, ...lines]

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const commandName = (argv: ReadonlyArray<string>): string => argv[0] ?? "process"

const invalidArgv = (): InvalidRequestError => InvalidRequestError.make({ message: "empty argv" })

const processFailure = (argv: ReadonlyArray<string>, detail: string): ProviderError =>
  ProviderError.make({
    message: detail.includes("ENOENT")
      ? `${commandName(argv)} failed: command not found. Install '${commandName(argv)}' and make sure it is on your PATH` +
        ` (coding-agent CLIs can be switched with LLM4TS_CODER)`
      : `${commandName(argv)} failed: ${detail}`
  })

/**
 * The orchestrator's own variables: its `LLM4TS_*` knobs and `_`, the path
 * of the binary the shell started. The standard `OTEL_*` variables stay:
 * other OpenTelemetry-aware tools (a CLI's own telemetry) read them too.
 */
const orchestratorOwn = (name: string): boolean => name === "_" || name.startsWith("LLM4TS_")

/** A drop-list entry as a test on a variable name; `*` stands for any run of characters. */
const dropped = (patterns: ReadonlyArray<string>): ((name: string) => boolean) => {
  const tests = patterns
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0)
    .map(
      (pattern) =>
        new RegExp(
          `^${pattern
            .split("*")
            .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
            .join(".*")}$`
        )
    )
  return (name) => tests.some((test) => test.test(name))
}

/**
 * What a child process inherits: this process's environment without the
 * orchestrator's own variables and without those `LLM4TS_CHILD_ENV_DROP`
 * names, then `envVars`. A coding agent, a gate or a setup command has no
 * use for llm4ts's knobs, and an agent that lists its environment should not
 * be pointed at the tool running it, nor handed a credential of the shell
 * that launched the run (ADR 0059). `envVars` are what the run means the
 * child to have, so the drop list does not touch them.
 */
export const childEnvironment = (
  parent: Readonly<Record<string, string | undefined>>,
  envVars: Readonly<Record<string, string>>
): Record<string, string> => {
  const withheld = dropped(settingValue("LLM4TS_CHILD_ENV_DROP", parent) ?? [])
  const inherited: Record<string, string> = {}
  for (const [name, value] of Object.entries(parent)) {
    if (value !== undefined && !orchestratorOwn(name) && !withheld(name)) {
      inherited[name] = value
    }
  }
  return { ...inherited, ...envVars }
}

/**
 * Every child leads its own process group (ADR 0058), so ending it ends what
 * it started too: a coding agent's own subprocess must not keep writing into
 * the checkout after the turn, the stop or the run is over. Not on Windows,
 * where `detached` means a new console.
 */
const ownGroups = process.platform !== "win32"

const liveGroups = new Set<number>()
const groupListeners = new Set<() => void>()
let exitHookInstalled = false

const killGroup = (pgid: number): void => {
  try {
    process.kill(-pgid, "SIGKILL")
  } catch {
    // the group is already empty
  }
}

const groupsChanged = (): void => {
  for (const listener of groupListeners) listener()
}

const trackGroup = (pid: number | undefined): void => {
  if (!ownGroups || pid === undefined) return
  liveGroups.add(pid)
  // A process that exits without running finalizers (a second Ctrl-C) still
  // takes its children with it; they no longer share the terminal's group.
  if (!exitHookInstalled) {
    exitHookInstalled = true
    process.once("exit", () => {
      for (const group of liveGroups) killGroup(group)
    })
  }
  groupsChanged()
}

/** The process groups of the children running now, for the writer lock. */
export const childGroups = {
  current: (): ReadonlyArray<number> => [...liveGroups],
  subscribe: (listener: () => void): (() => void) => {
    groupListeners.add(listener)
    return () => {
      groupListeners.delete(listener)
    }
  }
}

const spawnChild = (
  argv: ReadonlyArray<string>,
  cwd: string,
  envVars: Readonly<Record<string, string>>
): Effect.Effect<ChildProcessWithoutNullStreams, ProviderError> => {
  const [command, ...args] = argv
  if (command === undefined) {
    return Effect.fail(
      ProviderError.make({
        message: "process failed: empty argv"
      })
    )
  }

  // Windows only, and only for a batch file: `az`/`gemini` and friends
  // install as `.cmd`, which has to be resolved through PATHEXT and handed
  // to cmd.exe — the two things a shell does that a shell-less spawn does
  // not. See WindowsCommand.ts for why a shell is not the answer instead.
  const windows = process.platform === "win32" ? windowsInvocation(argv) : undefined
  const file = windows?.file ?? command
  const spawnArgs = windows === undefined ? args : windows.args

  return Effect.try({
    try: () => {
      const child = spawn(file, spawnArgs, {
        cwd,
        env: childEnvironment(process.env, envVars),
        stdio: "pipe",
        ...(ownGroups ? { detached: true } : {}),
        ...(windows === undefined ? {} : { windowsVerbatimArguments: windows.verbatim })
      })
      trackGroup(child.pid)
      return child
    },
    catch: (error) => processFailure(argv, errorMessage(error))
  })
}

const killChild = (child: ChildProcessWithoutNullStreams): Effect.Effect<void> =>
  Effect.sync(() => {
    const pid = child.pid
    if (ownGroups && pid !== undefined) {
      killGroup(pid)
      if (liveGroups.delete(pid)) groupsChanged()
    } else if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL")
    }
  })

const writeAndCloseStdin = (
  child: ChildProcessWithoutNullStreams,
  stdin: string | undefined
): void => {
  if (stdin === undefined) {
    child.stdin.end()
  } else {
    child.stdin.end(stdin)
  }
}

const awaitCapturedProcess = (
  child: ChildProcessWithoutNullStreams,
  argv: ReadonlyArray<string>,
  stdin: string | undefined
): Effect.Effect<ProcessResult, ProviderError> =>
  Effect.callback((resume) => {
    const stdout: Array<string> = []
    const stderr: Array<string> = []
    let stdoutDropped = 0
    let stderrDropped = 0
    const outLines = readline.createInterface({ input: child.stdout })
    const errLines = readline.createInterface({ input: child.stderr })

    const onStdout = (line: string): void => {
      if (stdout.length < maxCapturedStdoutLines) {
        stdout.push(line)
      } else {
        stdoutDropped += 1
      }
    }
    // Trimmed in batches, so a flood costs a splice per limit's worth of lines.
    const trimStderr = (): void => {
      const excess = stderr.length - maxCapturedStderrLines
      if (excess > 0) {
        stderr.splice(0, excess)
        stderrDropped += excess
      }
    }
    const onStderr = (line: string): void => {
      stderr.push(line)
      if (stderr.length >= 2 * maxCapturedStderrLines) {
        trimStderr()
      }
    }
    const onError = (error: Error): void => {
      resume(Effect.fail(processFailure(argv, error.message)))
    }
    const onClose = (exitCode: number | null): void => {
      trimStderr()
      resume(
        Effect.succeed(
          ProcessResult.make({
            stdout: boundedLines(stdout, stdoutDropped, "head"),
            stderr: boundedLines(stderr, stderrDropped, "tail"),
            exitCode: exitCode ?? -1
          })
        )
      )
    }

    outLines.on("line", onStdout)
    errLines.on("line", onStderr)
    child.once("error", onError)
    child.once("close", onClose)
    writeAndCloseStdin(child, stdin)

    return Effect.sync(() => {
      child.off("error", onError)
      child.off("close", onClose)
      outLines.close()
      errLines.close()
    })
  })

const runCaptured = (
  argv: ReadonlyArray<string>,
  cwd: string,
  envVars: Readonly<Record<string, string>>,
  stdin: string | undefined
): Effect.Effect<ProcessResult, LlmError> => {
  if (argv.length === 0) {
    return Effect.fail(invalidArgv())
  }

  return Effect.acquireUseRelease(
    spawnChild(argv, cwd, envVars),
    (child) => awaitCapturedProcess(child, argv, stdin),
    (child) => killChild(child)
  )
}

interface StreamOptions {
  readonly stdin: string | undefined
  readonly killOnClose: boolean
  readonly failOnNonZero: boolean
}

const childLines = (
  child: ChildProcessWithoutNullStreams,
  argv: ReadonlyArray<string>,
  options: StreamOptions
): Stream.Stream<string, LlmError> =>
  Stream.callback<string, LlmError>((queue) =>
    Effect.gen(function* () {
      const stderr: Array<string> = []
      const outLines = readline.createInterface({ input: child.stdout })
      const errLines = readline.createInterface({ input: child.stderr })

      const onStdout = (line: string): void => {
        Queue.offerUnsafe(queue, line)
      }
      const onStderr = (line: string): void => {
        if (stderr.length < maxStderrLines) {
          stderr.push(line)
        }
      }
      const onError = (error: Error): void => {
        Queue.failCauseUnsafe(queue, Cause.fail(processFailure(argv, error.message)))
      }
      const onClose = (exitCode: number | null): void => {
        if (options.failOnNonZero && exitCode !== 0) {
          const detail = `${commandName(argv)} exited with code ${exitCode ?? -1}${
            stderr.length === 0 ? "" : `: ${stderr.join("\n")}`
          }`
          Queue.failCauseUnsafe(queue, Cause.fail(processFailure(argv, detail)))
        } else {
          Queue.endUnsafe(queue)
        }
      }

      outLines.on("line", onStdout)
      errLines.on("line", onStderr)
      child.once("error", onError)
      child.once("close", onClose)

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          child.off("error", onError)
          child.off("close", onClose)
          outLines.close()
          errLines.close()
        }).pipe(Effect.andThen(options.killOnClose ? killChild(child) : Effect.void))
      )
    })
  )

const runStreaming = (
  argv: ReadonlyArray<string>,
  cwd: string,
  envVars: Readonly<Record<string, string>>,
  stdin: string | undefined
): Stream.Stream<string, LlmError> => {
  if (argv.length === 0) {
    return Stream.fail(invalidArgv())
  }

  return Stream.callback<string, LlmError>((queue) =>
    Effect.gen(function* () {
      const child = yield* Effect.acquireRelease(spawnChild(argv, cwd, envVars), (process) =>
        killChild(process)
      )
      const stderr: Array<string> = []
      const outLines = readline.createInterface({ input: child.stdout })
      const errLines = readline.createInterface({ input: child.stderr })

      const onStdout = (line: string): void => {
        Queue.offerUnsafe(queue, line)
      }
      const onStderr = (line: string): void => {
        if (stderr.length < maxStderrLines) {
          stderr.push(line)
        }
      }
      const onError = (error: Error): void => {
        Queue.failCauseUnsafe(queue, Cause.fail(processFailure(argv, error.message)))
      }
      const onClose = (exitCode: number | null): void => {
        if (exitCode === 0) {
          Queue.endUnsafe(queue)
        } else {
          const detail = `${commandName(argv)} exited with code ${exitCode ?? -1}${
            stderr.length === 0 ? "" : `: ${stderr.join("\n")}`
          }`
          Queue.failCauseUnsafe(queue, Cause.fail(processFailure(argv, detail)))
        }
      }

      outLines.on("line", onStdout)
      errLines.on("line", onStderr)
      child.once("error", onError)
      child.once("close", onClose)
      writeAndCloseStdin(child, stdin)

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          child.off("error", onError)
          child.off("close", onClose)
          outLines.close()
          errLines.close()
        })
      )
    })
  )
}

const writeLine = (
  child: ChildProcessWithoutNullStreams,
  argv: ReadonlyArray<string>,
  line: string
): Effect.Effect<void, ProviderError> =>
  Effect.callback((resume) => {
    const onError = (error: Error): void => {
      resume(Effect.fail(processFailure(argv, error.message)))
    }
    child.stdin.once("error", onError)
    child.stdin.write(`${line}\n`, (error) => {
      child.stdin.off("error", onError)
      resume(
        error === null || error === undefined
          ? Effect.void
          : Effect.fail(processFailure(argv, error.message))
      )
    })
    return Effect.sync(() => {
      child.stdin.off("error", onError)
    })
  })

const bidirectionalBundle = (
  stdin: Queue.Queue<string>,
  stdout: Stream.Stream<string, LlmError>
): BidirectionalProcess => [stdin, stdout]

const runBidirectional: ProcessExecutorShape["runBidirectional"] = (argv, cwd, envVars) => {
  if (argv.length === 0) {
    return Effect.fail(invalidArgv())
  }

  return Effect.gen(function* () {
    const input = yield* Effect.acquireRelease(Queue.unbounded<string>(), (queue) =>
      Queue.shutdown(queue).pipe(Effect.asVoid)
    )
    const child = yield* Effect.acquireRelease(spawnChild(argv, cwd, envVars), (process) =>
      killChild(process)
    )

    const pump = Effect.suspend(function loop(): Effect.Effect<void, ProviderError> {
      return Effect.flatMap(Queue.take(input), (line) =>
        writeLine(child, argv, line).pipe(Effect.andThen(Effect.suspend(loop)))
      )
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          child.stdin.end()
        })
      ),
      Effect.catchCause(() => Effect.void)
    )
    yield* Effect.forkScoped(pump)

    return bidirectionalBundle(
      input,
      childLines(child, argv, {
        stdin: undefined,
        killOnClose: false,
        failOnNonZero: false
      })
    )
  })
}

export const nodeProcessExecutor: ProcessExecutorShape = makeProcessExecutor({
  run: (argv, cwd, envVars) => runCaptured(argv, cwd, envVars, undefined),
  runStreaming: (argv, cwd, envVars) => runStreaming(argv, cwd, envVars, undefined),
  runWithStdin: (argv, cwd, envVars, stdin) => runCaptured(argv, cwd, envVars, stdin),
  runStreamingWithStdin: (argv, cwd, envVars, stdin) => runStreaming(argv, cwd, envVars, stdin),
  runBidirectional
})

export const NodeProcessExecutorLive = Layer.succeed(ProcessExecutor)(nodeProcessExecutor)
