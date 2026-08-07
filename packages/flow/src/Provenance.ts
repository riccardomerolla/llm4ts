import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { PersistenceError, PlanParseError, type FlowError } from "./FlowError.ts"
import type { PlainFileStoreShape } from "./Persistence.ts"

export class Provenance extends Schema.Class<Provenance>("Provenance")({
  schema: Schema.Int,
  pack: Schema.String,
  llm4tsVersion: Schema.String,
  createdAt: Schema.String,
  approvedBy: Schema.optionalKey(Schema.String),
  seats: Schema.Record(Schema.String, Schema.String),
  specs: Schema.Record(Schema.String, Schema.String),
  gateVerdicts: Schema.Record(Schema.String, Schema.String),
  equivalenceReport: Schema.optionalKey(Schema.String),
  fixSpecs: Schema.Array(Schema.String),
  // Context truncations recorded while producing this evidence
  // (Context.renderTruncation strings). A gate verdict rendered on a
  // partially-read spec pack says so HERE — that visibility is the whole
  // reason truncation is allowed at all. Defaulted so manifests written
  // before this field still load.
  contextTruncations: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
    Schema.withConstructorDefault(Effect.succeed([]))
  )
}) {}

const join = (root: string, path: string): string =>
  `${root.replace(/[\\/]+$/, "")}/${path.replace(/^[\\/]+/, "")}`

export interface ProvenanceStoreShape {
  readonly write: (path: string, provenance: Provenance) => Effect.Effect<void, FlowError>
  readonly load: (path: string) => Effect.Effect<Provenance, FlowError>
  readonly extend: (
    path: string,
    update: (current: Provenance) => Provenance
  ) => Effect.Effect<Provenance, FlowError>
  readonly hashFiles: (
    root: string,
    paths: ReadonlyArray<string>
  ) => Effect.Effect<Readonly<Record<string, string>>, PersistenceError>
}

export const makeProvenanceStore = (files: PlainFileStoreShape): ProvenanceStoreShape => {
  const write = (path: string, provenance: Provenance): Effect.Effect<void, FlowError> =>
    Schema.encodeEffect(Schema.fromJsonString(Provenance))(provenance).pipe(
      Effect.mapError((error) =>
        PlanParseError.make({
          message: `failed to encode provenance manifest ${path}: ${String(error)}`
        })
      ),
      Effect.flatMap((contents) => files.writeAtomic(path, `${contents}\n`))
    )

  const load = (path: string): Effect.Effect<Provenance, FlowError> =>
    Effect.flatMap(
      files.read(path),
      (contents): Effect.Effect<Provenance, FlowError> =>
        contents === undefined
          ? Effect.fail(
              PersistenceError.make({
                message: `provenance manifest does not exist: ${path}`
              })
            )
          : Schema.decodeUnknownEffect(Schema.fromJsonString(Provenance))(contents).pipe(
              Effect.mapError((error) =>
                PlanParseError.make({
                  message: `malformed provenance manifest ${path}: ${String(error)}`
                })
              )
            )
    )

  const extend = (
    path: string,
    update: (current: Provenance) => Provenance
  ): Effect.Effect<Provenance, FlowError> =>
    Effect.flatMap(load(path), (current) => {
      const updated = update(current)
      return write(path, updated).pipe(Effect.as(updated))
    })

  const hashFiles = (
    root: string,
    paths: ReadonlyArray<string>
  ): Effect.Effect<Readonly<Record<string, string>>, PersistenceError> =>
    Effect.forEach(paths, (path) =>
      files
        .hashSha256(join(root, path))
        .pipe(Effect.map((hash): readonly [path: string, hash: string] => [path, hash]))
    ).pipe(Effect.map(Object.fromEntries))

  return { write, load, extend, hashFiles }
}
