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

const maxStderrLines = 256

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const commandName = (argv: ReadonlyArray<string>): string => argv[0] ?? "process"

const invalidArgv = (): InvalidRequestError => InvalidRequestError.make({ message: "empty argv" })

const processFailure = (argv: ReadonlyArray<string>, detail: string): ProviderError =>
  ProviderError.make({
    message: `${commandName(argv)} failed: ${detail}`
  })

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

  return Effect.try({
    try: () =>
      spawn(command, args, {
        cwd,
        env: {
          ...process.env,
          ...envVars
        },
        stdio: "pipe"
      }),
    catch: (error) => processFailure(argv, errorMessage(error))
  })
}

const killChild = (child: ChildProcessWithoutNullStreams): Effect.Effect<void> =>
  Effect.sync(() => {
    if (child.exitCode === null && child.signalCode === null) {
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
    const outLines = readline.createInterface({ input: child.stdout })
    const errLines = readline.createInterface({ input: child.stderr })

    const onStdout = (line: string): void => {
      stdout.push(line)
    }
    const onStderr = (line: string): void => {
      stderr.push(line)
    }
    const onError = (error: Error): void => {
      resume(Effect.fail(processFailure(argv, error.message)))
    }
    const onClose = (exitCode: number | null): void => {
      resume(
        Effect.succeed(
          ProcessResult.make({
            stdout,
            stderr,
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
