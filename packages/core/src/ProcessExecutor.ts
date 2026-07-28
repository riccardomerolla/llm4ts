import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import type * as Queue from "effect/Queue"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import { InvalidRequestError, ProviderError, type LlmError } from "./Errors.ts"

const emptyLines: ReadonlyArray<string> = Object.freeze([])
const emptyEnvironment: Readonly<Record<string, string>> = Object.freeze({})

export class ProcessResult extends Schema.Class<ProcessResult>("ProcessResult")({
  stdout: Schema.Array(Schema.String),
  exitCode: Schema.Int,
  stderr: Schema.Array(Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed(emptyLines))
  )
}) {}

export class ProcessInvocation extends Schema.Class<ProcessInvocation>("ProcessInvocation")({
  argv: Schema.Array(Schema.String),
  cwd: Schema.String,
  envVars: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed(emptyEnvironment))
  ),
  stdin: Schema.optionalKey(Schema.String),
  streaming: Schema.Boolean
}) {}

export type BidirectionalProcess = readonly [
  stdin: Queue.Queue<string>,
  stdout: Stream.Stream<string, LlmError>
]

export interface ProcessExecutorShape {
  readonly run: (
    argv: ReadonlyArray<string>,
    cwd: string,
    envVars: Readonly<Record<string, string>>
  ) => Effect.Effect<ProcessResult, LlmError>
  readonly runStreaming: (
    argv: ReadonlyArray<string>,
    cwd: string,
    envVars: Readonly<Record<string, string>>
  ) => Stream.Stream<string, LlmError>
  readonly runWithStdin: (
    argv: ReadonlyArray<string>,
    cwd: string,
    envVars: Readonly<Record<string, string>>,
    stdin: string
  ) => Effect.Effect<ProcessResult, LlmError>
  readonly runStreamingWithStdin: (
    argv: ReadonlyArray<string>,
    cwd: string,
    envVars: Readonly<Record<string, string>>,
    stdin: string
  ) => Stream.Stream<string, LlmError>
  readonly runBidirectional: (
    argv: ReadonlyArray<string>,
    cwd: string,
    envVars: Readonly<Record<string, string>>
  ) => Effect.Effect<BidirectionalProcess, LlmError, Scope.Scope>
}

export class ProcessExecutor extends Context.Service<ProcessExecutor, ProcessExecutorShape>()(
  "@llm4ts/core/ProcessExecutor"
) {}

export interface ProcessExecutorPrimitives {
  readonly run: ProcessExecutorShape["run"]
  readonly runStreaming: ProcessExecutorShape["runStreaming"]
  readonly runWithStdin?: ProcessExecutorShape["runWithStdin"]
  readonly runStreamingWithStdin?: ProcessExecutorShape["runStreamingWithStdin"]
  readonly runBidirectional?: ProcessExecutorShape["runBidirectional"]
}

export const makeProcessExecutor = (
  primitives: ProcessExecutorPrimitives
): ProcessExecutorShape => ({
  run: primitives.run,
  runStreaming: primitives.runStreaming,
  runWithStdin:
    primitives.runWithStdin ?? ((argv, cwd, envVars, _stdin) => primitives.run(argv, cwd, envVars)),
  runStreamingWithStdin:
    primitives.runStreamingWithStdin ??
    ((argv, cwd, envVars, _stdin) => primitives.runStreaming(argv, cwd, envVars)),
  runBidirectional:
    primitives.runBidirectional ??
    ((argv, _cwd, _envVars) =>
      Effect.fail(
        InvalidRequestError.make({
          message: `${argv[0] ?? "process"} does not support bidirectional sessions`
        })
      ))
})

export const processCommandKey = (argv: ReadonlyArray<string>): string => JSON.stringify(argv)

export interface FakeProcessExecutor {
  readonly executor: ProcessExecutorShape
  readonly recorded: Effect.Effect<ReadonlyArray<ProcessInvocation>>
}

export interface FakeProcessPlan {
  readonly responses?: ReadonlyMap<string, ProcessResult>
  readonly streamResponses?: ReadonlyMap<string, ReadonlyArray<string>>
}

export const makeFakeProcessExecutor = Effect.fn("@llm4ts/core/ProcessExecutor.makeFake")(
  function* (plan: FakeProcessPlan = {}): Effect.fn.Return<FakeProcessExecutor> {
    const invocations = yield* Ref.make<ReadonlyArray<ProcessInvocation>>([])
    const record = (invocation: ProcessInvocation): Effect.Effect<void> =>
      Ref.update(invocations, (current) => [...current, invocation])

    const executor = makeProcessExecutor({
      run: (argv, cwd, envVars) => {
        const invocation = ProcessInvocation.make({
          argv,
          cwd,
          envVars,
          streaming: false
        })
        const response = plan.responses?.get(processCommandKey(argv))
        return record(invocation).pipe(
          Effect.andThen(
            response === undefined
              ? Effect.fail(
                  ProviderError.make({
                    message: `No fake response for argv: ${argv.join(" ")}`
                  })
                )
              : Effect.succeed(response)
          )
        )
      },
      runStreaming: (argv, cwd, envVars) => {
        const invocation = ProcessInvocation.make({
          argv,
          cwd,
          envVars,
          streaming: true
        })
        const lines = plan.streamResponses?.get(processCommandKey(argv)) ?? emptyLines
        return Stream.concat(
          Stream.drain(Stream.fromEffect(record(invocation))),
          Stream.fromIterable(lines)
        )
      }
    })

    return {
      executor,
      recorded: Ref.get(invocations)
    }
  }
)
