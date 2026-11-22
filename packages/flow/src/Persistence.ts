import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import {
  FlowAborted,
  PersistenceError,
  PlanParseError,
  UnsupportedSchemaVersion
} from "./FlowError.ts"
import type { FlowError } from "./FlowError.ts"
import { parsePlan } from "./Plan.ts"
import type { Plan } from "./Plan.ts"

export interface PlainFileStoreShape {
  readonly read: (path: string) => Effect.Effect<string | undefined, PersistenceError>
  readonly writeAtomic: (path: string, contents: string) => Effect.Effect<void, PersistenceError>
  readonly append: (path: string, contents: string) => Effect.Effect<void, PersistenceError>
  readonly remove: (path: string) => Effect.Effect<void, PersistenceError>
  readonly hashSha256: (path: string) => Effect.Effect<string, PersistenceError>
}

export class PlainFileStore extends Context.Service<PlainFileStore, PlainFileStoreShape>()(
  "@llm4ts/flow/PlainFileStore"
) {}

const hexDigest = (buffer: ArrayBuffer): string =>
  Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")

const sha256Hex = (path: string, contents: string): Effect.Effect<string, PersistenceError> =>
  Effect.tryPromise({
    try: async () =>
      hexDigest(
        await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(contents))
      ),
    catch: (error) =>
      PersistenceError.make({
        message: `failed to hash ${path}: ${error instanceof Error ? error.message : String(error)}`,
        cause: error
      })
  })

export interface MemoryPlainFileStore {
  readonly store: PlainFileStoreShape
  readonly files: Effect.Effect<Readonly<Record<string, string>>>
  readonly replace: (files: Readonly<Record<string, string>>) => Effect.Effect<void>
}

export const makeMemoryPlainFileStore = (
  initial: Readonly<Record<string, string>> = {}
): Effect.Effect<MemoryPlainFileStore> =>
  Ref.make(initial).pipe(
    Effect.map((state) => {
      const store: PlainFileStoreShape = {
        read: (path) => Ref.get(state).pipe(Effect.map((files) => files[path])),
        writeAtomic: (path, contents) =>
          Ref.update(state, (files) => ({ ...files, [path]: contents })),
        append: (path, contents) =>
          Ref.update(state, (files) => ({
            ...files,
            [path]: `${files[path] ?? ""}${contents}`
          })),
        remove: (path) =>
          Ref.update(state, (files) =>
            Object.fromEntries(Object.entries(files).filter(([candidate]) => candidate !== path))
          ),
        hashSha256: (path) =>
          Ref.get(state).pipe(
            Effect.flatMap((files) => {
              const contents = files[path]
              return contents === undefined
                ? Effect.fail(
                    PersistenceError.make({
                      message: `failed to hash ${path}: file does not exist`
                    })
                  )
                : sha256Hex(path, contents)
            })
          )
      }
      return {
        store,
        files: Ref.get(state),
        replace: (files: Readonly<Record<string, string>>) => Ref.set(state, files)
      }
    })
  )

export interface PlanStoreShape {
  readonly save: (path: string, plan: Plan) => Effect.Effect<void, PersistenceError>
  readonly load: (
    path: string
  ) => Effect.Effect<Plan | undefined, PersistenceError | PlanParseError>
  readonly remove: (path: string) => Effect.Effect<void, PersistenceError>
  readonly recoverOrCreate: <E, R>(
    path: string,
    create: Effect.Effect<Plan, E, R>
  ) => Effect.Effect<Plan, E | PersistenceError | PlanParseError, R>
  /**
   * The cut-off journal of the plan at `path` (ADR 0056). A store without
   * one runs every task as if no run of it had ever been cut off.
   */
  readonly attempts?: (path: string) => TaskAttemptsShape
}

/**
 * Which of a plan's tasks were running when their process died (ADR 0056).
 * A task's run is marked before it starts and unmarked when it ends while
 * the process lives, whatever the ending; a mark found at the next start
 * is a run that was cut off.
 */
export interface TaskAttemptsShape {
  /**
   * Marks the task running and answers how many of its earlier runs were
   * cut off. Fails, marking nothing, once that count reaches the limit.
   */
  readonly begin: (task: string) => Effect.Effect<number, FlowError>
  /** The run ended while the process lived; a completed task leaves the journal. */
  readonly end: (task: string, completed: boolean) => Effect.Effect<void, FlowError>
}

/** Where the cut-off journal of the plan at `planPath` lives. */
export const attemptsPath = (planPath: string): string => `${planPath}.attempts.json`

/** A task whose run was cut off this many times is not started again. */
export const defaultCutOffLimit = 3

const TaskAttempt = Schema.Struct({ running: Schema.Boolean, cutOff: Schema.Int })
const TaskAttempts = Schema.Struct({ tasks: Schema.Record(Schema.String, TaskAttempt) })
const taskAttemptsVersion = 1

export const makeTaskAttempts = (
  files: PlainFileStoreShape,
  planPath: string,
  cutOffLimit: number = defaultCutOffLimit
): TaskAttemptsShape => {
  const path = attemptsPath(planPath)
  const load = Effect.map(
    loadVersioned(files, path, taskAttemptsVersion, TaskAttempts),
    (stored) => stored?.tasks ?? {}
  )
  const save = (tasks: typeof TaskAttempts.Type.tasks): Effect.Effect<void, FlowError> =>
    Object.keys(tasks).length === 0
      ? files.remove(path)
      : saveVersioned(files, path, taskAttemptsVersion, TaskAttempts, { tasks })
  return {
    begin: (task) =>
      Effect.gen(function* () {
        const tasks = yield* load
        const stored = tasks[task]
        const cutOff = (stored?.cutOff ?? 0) + (stored?.running === true ? 1 : 0)
        if (cutOff >= cutOffLimit) {
          return yield* FlowAborted.make({
            message: `task "${task}" was cut off ${cutOff} time(s) before it finished and is not started again; delete ${path} to run it once more`
          })
        }
        yield* save({ ...tasks, [task]: { running: true, cutOff } })
        return cutOff
      }),
    end: (task, completed) =>
      Effect.gen(function* () {
        const tasks = yield* load
        const stored = tasks[task]
        if (stored === undefined) {
          return
        }
        const { [task]: _ended, ...others } = tasks
        yield* save(completed ? others : { ...others, [task]: { ...stored, running: false } })
      })
  }
}

export interface PlanStoreOptions {
  /** A task cut off this many times is not started again; default `defaultCutOffLimit`. */
  readonly cutOffLimit?: number
}

export const makePlanStore = (
  files: PlainFileStoreShape,
  options: PlanStoreOptions = {}
): PlanStoreShape => {
  const save = (path: string, plan: Plan): Effect.Effect<void, PersistenceError> =>
    files.writeAtomic(path, plan.render)

  const load = (path: string): Effect.Effect<Plan | undefined, PersistenceError | PlanParseError> =>
    Effect.flatMap(files.read(path), (contents) =>
      contents === undefined
        ? Effect.succeed(undefined)
        : parsePlan(contents).pipe(Effect.map((plan) => plan))
    )

  const recoverOrCreate = <E, R>(
    path: string,
    create: Effect.Effect<Plan, E, R>
  ): Effect.Effect<Plan, E | PersistenceError | PlanParseError, R> =>
    Effect.flatMap(load(path), (stored) =>
      stored === undefined ? Effect.tap(create, (plan) => save(path, plan)) : Effect.succeed(stored)
    )

  return {
    save,
    load,
    remove: (path) => Effect.andThen(files.remove(path), files.remove(attemptsPath(path))),
    recoverOrCreate,
    attempts: (path) => makeTaskAttempts(files, path, options.cutOffLimit)
  }
}

interface VersionedEnvelope {
  readonly schemaVersion: number
  readonly value: unknown
}

const VersionedEnvelope = Schema.Struct({
  schemaVersion: Schema.Int,
  value: Schema.Unknown
})

export const saveVersioned = Effect.fn("@llm4ts/flow/Persistence.saveVersioned")(function* <
  A,
  E,
  RD,
  RE
>(
  files: PlainFileStoreShape,
  path: string,
  schemaVersion: number,
  schema: Schema.ConstraintCodec<A, E, RD, RE>,
  value: A
): Effect.fn.Return<void, FlowError, RE> {
  const encoded = yield* Schema.encodeEffect(schema)(value).pipe(
    Effect.mapError((error) =>
      PlanParseError.make({
        message: `failed to encode versioned document ${path}: ${String(error)}`
      })
    )
  )
  yield* files.writeAtomic(
    path,
    `${JSON.stringify({ schemaVersion, value: encoded }, undefined, 2)}\n`
  )
})

export const loadVersioned = Effect.fn("@llm4ts/flow/Persistence.loadVersioned")(function* <
  A,
  E,
  RD,
  RE
>(
  files: PlainFileStoreShape,
  path: string,
  expectedVersion: number,
  schema: Schema.ConstraintCodec<A, E, RD, RE>
): Effect.fn.Return<A | undefined, FlowError, RD> {
  const contents = yield* files.read(path)
  if (contents === undefined) {
    return undefined
  }
  const envelope: VersionedEnvelope = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(VersionedEnvelope)
  )(contents).pipe(
    Effect.mapError((error) =>
      PlanParseError.make({
        message: `malformed versioned document ${path}: ${String(error)}`
      })
    )
  )
  if (envelope.schemaVersion !== expectedVersion) {
    return yield* UnsupportedSchemaVersion.make({
      path,
      expected: expectedVersion,
      actual: envelope.schemaVersion
    })
  }
  return yield* Schema.decodeUnknownEffect(schema)(envelope.value).pipe(
    Effect.mapError((error) =>
      PlanParseError.make({
        message: `invalid versioned document ${path}: ${String(error)}`
      })
    )
  )
})
