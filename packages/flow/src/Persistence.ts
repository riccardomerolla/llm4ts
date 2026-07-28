import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { PlanParseError, UnsupportedSchemaVersion, type FlowError } from "./FlowError.ts"
import type { PersistenceError } from "./FlowError.ts"
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
}

export const makePlanStore = (files: PlainFileStoreShape): PlanStoreShape => {
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
    remove: files.remove,
    recoverOrCreate
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
