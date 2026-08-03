import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Capabilities } from "@llm4ts/core/Capability"
import type { ProcessExecutorShape } from "@llm4ts/core/ProcessExecutor"
import { guarded } from "./CapabilityGuard.ts"
import {
  PlanParseError,
  ProcessError,
  UnsupportedSchemaVersion,
  type FlowError
} from "./FlowError.ts"
import type { FlowEventsShape } from "./FlowEvents.ts"
import type { ComparisonPolicy } from "./Pack.ts"
import type { PlainFileStoreShape } from "./Persistence.ts"

export const EquivTier = Schema.Literals(["generated", "captured"])
export type EquivTier = typeof EquivTier.Type

export const RecordObservation = Schema.Struct({
  type: Schema.Literal("record"),
  kind: Schema.String,
  fields: Schema.Record(Schema.String, Schema.String)
})
export type RecordObservation = typeof RecordObservation.Type

export const DbMutationObservation = Schema.Struct({
  type: Schema.Literal("db"),
  table: Schema.String,
  op: Schema.String,
  key: Schema.Record(Schema.String, Schema.String),
  set: Schema.Record(Schema.String, Schema.String)
})
export type DbMutationObservation = typeof DbMutationObservation.Type

export const MessageObservation = Schema.Struct({
  type: Schema.Literal("message"),
  topic: Schema.String,
  key: Schema.String,
  fields: Schema.Record(Schema.String, Schema.String)
})
export type MessageObservation = typeof MessageObservation.Type

export const EquivObservation = Schema.Union([
  RecordObservation,
  DbMutationObservation,
  MessageObservation
])
export type EquivObservation = typeof EquivObservation.Type

/**
 * The observation properties that carry a field map, whose values a replay
 * harness may legitimately emit as JSON scalars.
 */
const fieldMapKeys: ReadonlyArray<string> = ["fields", "key", "set"]

const canonicalValue = (value: unknown): string => {
  switch (typeof value) {
    case "string":
      return value
    case "number":
      return Number.isFinite(value) ? String(value) : ""
    case "boolean":
      return String(value)
    case "object":
      // null reads as "no value", which the legacy side renders as empty.
      return value === null ? "" : JSON.stringify(value)
    default:
      return ""
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Canonicalises the field maps of parsed observation JSON so a replay harness
 * can emit natural JSON types.
 *
 * Observations compare field values as strings, and the schema accordingly
 * required strings — but a harness dumping a COBOL record emits numerics as
 * JSON numbers (`"ZSTC": 0`), which failed the whole replay stage with a
 * schema error rather than a diff. Scalars are rendered here, on both the
 * expected and the actual side, so the comparison stays string-based and
 * symmetric. Note that JSON numbers carry no trailing zeros: a harness that
 * needs fixed precision (money, `PIC 9(5)V99`) should emit those fields as
 * strings.
 */
export const canonicaliseObservations = (parsed: unknown): unknown => {
  if (!Array.isArray(parsed)) {
    return parsed
  }
  return parsed.map((observation) => {
    if (!isPlainObject(observation)) {
      return observation
    }
    const canonicalised: Record<string, unknown> = { ...observation }
    for (const key of fieldMapKeys) {
      const map = canonicalised[key]
      if (isPlainObject(map)) {
        canonicalised[key] = Object.fromEntries(
          Object.entries(map).map(([name, value]) => [name, canonicalValue(value)])
        )
      }
    }
    return canonicalised
  })
}

/** One field map rendered to the strings observations compare as. */
export const canonicaliseFieldMap = (
  map: Readonly<Record<string, unknown>>
): Readonly<Record<string, string>> =>
  Object.fromEntries(Object.entries(map).map(([name, value]) => [name, canonicalValue(value)]))

/** `canonicaliseObservations` applied to a parsed vector's observations. */
export const canonicaliseVector = (parsed: unknown): unknown =>
  isPlainObject(parsed) && Array.isArray(parsed.observations)
    ? { ...parsed, observations: canonicaliseObservations(parsed.observations) }
    : parsed

export const Observations = Object.freeze({
  record: (kind: string, fields: Readonly<Record<string, string>>): RecordObservation => ({
    type: "record",
    kind,
    fields
  }),
  dbMutation: (
    table: string,
    op: string,
    key: Readonly<Record<string, string>>,
    set: Readonly<Record<string, string>>
  ): DbMutationObservation => ({ type: "db", table, op, key, set }),
  message: (
    topic: string,
    key: string,
    fields: Readonly<Record<string, string>>
  ): MessageObservation => ({ type: "message", topic, key, fields })
})

export class EquivVector extends Schema.Class<EquivVector>("EquivVector")({
  schemaVersion: Schema.Int,
  program: Schema.String,
  id: Schema.String,
  tier: EquivTier,
  rules: Schema.Array(Schema.String),
  inputs: Schema.Json,
  observations: Schema.Array(EquivObservation)
}) {}

export const CurrentEquivSchema = 1

export class MissingObservation extends Schema.TaggedClass<MissingObservation>()("Missing", {
  expected: EquivObservation
}) {}

export class UnexpectedObservation extends Schema.TaggedClass<UnexpectedObservation>()(
  "Unexpected",
  {
    actual: EquivObservation
  }
) {}

export class ObservationFieldDiff extends Schema.TaggedClass<ObservationFieldDiff>()("FieldDiff", {
  at: Schema.String,
  field: Schema.String,
  expected: Schema.String,
  actual: Schema.String
}) {}

export const EquivMismatch = Schema.Union([
  MissingObservation,
  UnexpectedObservation,
  ObservationFieldDiff
])
export type EquivMismatch = typeof EquivMismatch.Type

const sortedEntries = (
  record: Readonly<Record<string, string>>
): ReadonlyArray<readonly [string, string]> =>
  Object.entries(record).sort(([left], [right]) => left.localeCompare(right))

const identityOf = (observation: EquivObservation): string => {
  switch (observation.type) {
    case "record":
      return `record ${observation.kind}`
    case "message":
      return `message ${observation.topic} ${observation.key}`
    case "db":
      return `db ${observation.table} ${observation.op} ${sortedEntries(observation.key)
        .map(([key, value]) => `${key}=${value}`)
        .join(",")}`
  }
}

const fieldsOf = (observation: EquivObservation): Readonly<Record<string, string>> =>
  observation.type === "db" ? observation.set : observation.fields

const canonical = (observation: EquivObservation): string =>
  JSON.stringify({
    ...observation,
    ...(observation.type === "db"
      ? {
          key: Object.fromEntries(sortedEntries(observation.key)),
          set: Object.fromEntries(sortedEntries(observation.set))
        }
      : { fields: Object.fromEntries(sortedEntries(observation.fields)) })
  })

const scrub = (observation: EquivObservation, ignore: ReadonlySet<string>): EquivObservation => {
  const omit = (fields: Readonly<Record<string, string>>): Readonly<Record<string, string>> =>
    Object.fromEntries(Object.entries(fields).filter(([key]) => !ignore.has(key)))
  switch (observation.type) {
    case "record":
      return Observations.record(observation.kind, omit(observation.fields))
    case "message":
      return Observations.message(observation.topic, observation.key, omit(observation.fields))
    case "db":
      return Observations.dbMutation(
        observation.table,
        observation.op,
        omit(observation.key),
        omit(observation.set)
      )
  }
}

const fieldDiffs = (
  expected: EquivObservation,
  actual: EquivObservation
): ReadonlyArray<EquivMismatch> => {
  const expectedFields = fieldsOf(expected)
  const actualFields = fieldsOf(actual)
  return [...new Set([...Object.keys(expectedFields), ...Object.keys(actualFields)])]
    .sort()
    .flatMap((field) =>
      expectedFields[field] === actualFields[field]
        ? []
        : [
            ObservationFieldDiff.make({
              at: identityOf(expected),
              field,
              expected: expectedFields[field] ?? "(absent)",
              actual: actualFields[field] ?? "(absent)"
            })
          ]
    )
}

const positionalDiff = (
  expected: ReadonlyArray<EquivObservation>,
  actual: ReadonlyArray<EquivObservation>
): ReadonlyArray<EquivMismatch> => {
  const result: Array<EquivMismatch> = []
  const maximum = Math.max(expected.length, actual.length)
  for (let index = 0; index < maximum; index += 1) {
    const expectedItem = expected[index]
    const actualItem = actual[index]
    if (expectedItem === undefined && actualItem !== undefined) {
      result.push(UnexpectedObservation.make({ actual: actualItem }))
    } else if (expectedItem !== undefined && actualItem === undefined) {
      result.push(MissingObservation.make({ expected: expectedItem }))
    } else if (expectedItem !== undefined && actualItem !== undefined) {
      if (canonical(expectedItem) === canonical(actualItem)) {
        continue
      }
      if (identityOf(expectedItem) === identityOf(actualItem)) {
        result.push(...fieldDiffs(expectedItem, actualItem))
      } else {
        result.push(MissingObservation.make({ expected: expectedItem }))
        result.push(UnexpectedObservation.make({ actual: actualItem }))
      }
    }
  }
  return result
}

export const diffObservations = (
  expected: ReadonlyArray<EquivObservation>,
  actual: ReadonlyArray<EquivObservation>,
  policy: ComparisonPolicy
): ReadonlyArray<EquivMismatch> => {
  const expectedScrubbed = expected.map((item) => scrub(item, policy.ignore))
  const actualScrubbed = actual.map((item) => scrub(item, policy.ignore))
  if (policy.ordering === "Ordered") {
    return positionalDiff(expectedScrubbed, actualScrubbed)
  }
  if (policy.ordering === "PerKey") {
    const keys = [
      ...new Set([...expectedScrubbed.map(identityOf), ...actualScrubbed.map(identityOf)])
    ].sort()
    return keys.flatMap((key) =>
      positionalDiff(
        expectedScrubbed.filter((item) => identityOf(item) === key),
        actualScrubbed.filter((item) => identityOf(item) === key)
      )
    )
  }

  const remainingActual = [...actualScrubbed]
  const unmatchedExpected: Array<EquivObservation> = []
  for (const item of expectedScrubbed) {
    const index = remainingActual.findIndex((candidate) => canonical(candidate) === canonical(item))
    if (index < 0) {
      unmatchedExpected.push(item)
    } else {
      remainingActual.splice(index, 1)
    }
  }
  const mismatches: Array<EquivMismatch> = []
  const missing: Array<EquivObservation> = []
  for (const item of unmatchedExpected) {
    const index = remainingActual.findIndex(
      (candidate) => identityOf(candidate) === identityOf(item)
    )
    const matching = index < 0 ? undefined : remainingActual[index]
    if (matching === undefined) {
      missing.push(item)
    } else {
      mismatches.push(...fieldDiffs(item, matching))
      remainingActual.splice(index, 1)
    }
  }
  return [
    ...mismatches,
    ...missing.map((expectedItem) => MissingObservation.make({ expected: expectedItem })),
    ...remainingActual.map((actualItem) => UnexpectedObservation.make({ actual: actualItem }))
  ]
}

export class ReplayedObserved extends Schema.TaggedClass<ReplayedObserved>()("Observed", {
  actual: Schema.Array(EquivObservation)
}) {}

export class ReplayedCrashed extends Schema.TaggedClass<ReplayedCrashed>()("Crashed", {
  exitCode: Schema.Int,
  problem: Schema.String
}) {}

export const Replayed = Schema.Union([ReplayedObserved, ReplayedCrashed])
export type Replayed = typeof Replayed.Type

const vectorCodec = Schema.fromJsonString(EquivVector)

export const writeEquivVectors = Effect.fn("@llm4ts/flow/Equiv.writeVectors")(function* (
  files: PlainFileStoreShape,
  path: string,
  vectors: ReadonlyArray<EquivVector>
): Effect.fn.Return<void, FlowError> {
  const lines = yield* Effect.forEach(
    vectors,
    (vector) =>
      Schema.encodeEffect(vectorCodec)(vector).pipe(
        Effect.mapError((error) =>
          PlanParseError.make({
            message: `failed to encode equivalence vector: ${String(error)}`
          })
        )
      ),
    { concurrency: 1 }
  )
  yield* files.writeAtomic(path, `${lines.join("\n")}\n`)
})

export const readEquivVectors = Effect.fn("@llm4ts/flow/Equiv.readVectors")(function* (
  files: PlainFileStoreShape,
  path: string
): Effect.fn.Return<ReadonlyArray<EquivVector>, FlowError> {
  const contents = yield* files.read(path)
  if (contents === undefined) {
    return []
  }
  const vectors = yield* Effect.forEach(
    contents
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
    (line, index) =>
      Effect.try({
        try: () => canonicaliseVector(JSON.parse(line)),
        catch: () =>
          PlanParseError.make({
            message: `malformed vector at ${path}:${index + 1}: not JSON`
          })
      }).pipe(
        Effect.flatMap((parsed) =>
          Schema.decodeUnknownEffect(EquivVector)(parsed).pipe(
            Effect.mapError((error) =>
              PlanParseError.make({
                message: `malformed vector at ${path}:${index + 1}: ${String(error)}`
              })
            )
          )
        )
      ),
    { concurrency: 1 }
  )
  for (const vector of vectors) {
    if (vector.schemaVersion !== CurrentEquivSchema) {
      return yield* UnsupportedSchemaVersion.make({
        path,
        expected: CurrentEquivSchema,
        actual: vector.schemaVersion
      })
    }
  }
  return vectors
})

export const replayEquivVector = Effect.fn("@llm4ts/flow/Equiv.replayVector")(function* (
  process: ProcessExecutorShape,
  events: FlowEventsShape,
  command: ReadonlyArray<string>,
  root: string,
  vector: EquivVector
): Effect.fn.Return<Replayed, FlowError> {
  const executable = command[0]
  if (executable === undefined) {
    return yield* ProcessError.make({
      message: "replay",
      detail: "empty replay command"
    })
  }
  const input = yield* Schema.encodeEffect(vectorCodec)(vector).pipe(
    Effect.mapError((error) =>
      PlanParseError.make({
        message: `failed to encode vector ${vector.program}/${vector.id}: ${String(error)}`
      })
    )
  )
  const result = yield* guarded(
    Capabilities.Exec(executable),
    "equivalence replay",
    events,
    process.runWithStdin(command, root, {}, input).pipe(
      Effect.mapError((error) =>
        ProcessError.make({
          message: "equivalence replay",
          detail: error.message
        })
      )
    )
  )
  if (result.exitCode !== 0) {
    return ReplayedCrashed.make({
      exitCode: result.exitCode,
      problem: [...result.stderr, ...result.stdout].join("\n")
    })
  }
  const output = result.stdout.join("\n")
  const actual = yield* Effect.try({
    try: () => canonicaliseObservations(JSON.parse(output)),
    catch: () =>
      PlanParseError.make({
        message:
          `replay output for ${vector.program}/${vector.id} is not JSON: ` +
          `${output.slice(0, 200)}`
      })
  }).pipe(
    Effect.flatMap((parsed) =>
      Schema.decodeUnknownEffect(Schema.Array(EquivObservation))(parsed).pipe(
        Effect.mapError((error) =>
          PlanParseError.make({
            message: `replay output for ${vector.program}/${vector.id} is not an observation array: ${String(error)}`
          })
        )
      )
    )
  )
  return ReplayedObserved.make({ actual })
})
