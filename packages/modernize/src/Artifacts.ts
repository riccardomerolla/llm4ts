import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type { FlowError } from "@llm4ts/flow/FlowError"
import type { PlainFileStoreShape } from "@llm4ts/flow/Persistence"

export class ProgramUnit extends Schema.Class<ProgramUnit>("ProgramUnit")({
  name: Schema.String,
  sourcePath: Schema.String
}) {}

export class ProgramArtifacts extends Schema.Class<ProgramArtifacts>("ProgramArtifacts")({
  spec: Schema.String,
  feature: Schema.String,
  traceability: Schema.String,
  mapping: Schema.String
}) {}

export class ResumeSummary extends Schema.Class<ResumeSummary>("ResumeSummary")({
  created: Schema.Array(Schema.String),
  skipped: Schema.Array(Schema.String)
}) {}

const programName = (name: string): string => name.toLowerCase()

/** The four per-program artifact paths under `directory`, relative to the repository. */
export const programArtifactPaths = (
  unit: ProgramUnit,
  directory = "docs/modernization"
): ReadonlyArray<string> => [
  `${directory}/specs/${unit.name}.md`,
  `${directory}/features/${programName(unit.name)}.feature`,
  `${directory}/traceability/${unit.name}.md`,
  `${directory}/mapping/${unit.name}.md`
]

export interface ExtractProgramsOptions<E2, R2> {
  /**
   * How many programs extract at once (default 1: the sequential order the
   * units were given in). The programs of a wave are independent — each
   * analyst reads only its source and resolved closure and writes only its
   * own four files — so the bound is about the model seat's quota, not about
   * correctness.
   */
  readonly concurrency?: number
  /**
   * Runs after a program's four artifacts are on disk and before it counts as
   * created — the seam for per-program post-processing (pattern tagging, the
   * program's own commit). Runs under the same concurrency as extraction:
   * anything in it that must not interleave (git) serialises itself.
   */
  readonly onCreated?: (unit: ProgramUnit) => Effect.Effect<void, E2, R2>
}

type Outcome = "created" | "skipped" | "not-started"

/**
 * Extracts every unit whose spec is missing, writes its four artifacts, and
 * reports what was created and what was skipped. Resumable by construction:
 * a rerun skips every program whose spec exists.
 *
 * Failure keeps finished work: a program that fails stops NEW programs from
 * starting, but programs already in flight run to completion and land on
 * disk (and through `onCreated`) before the first failure, in unit order, is
 * re-raised. With `concurrency` 1 that is exactly fail-fast; above 1 a quota
 * death costs only the programs it interrupted, and a rerun resumes the rest.
 */
export const extractProgramsResumably = Effect.fn(
  "@llm4ts/modernize/Artifacts.extractProgramsResumably"
)(function* <E, R, E2 = never, R2 = never>(
  files: PlainFileStoreShape,
  units: ReadonlyArray<ProgramUnit>,
  extract: (unit: ProgramUnit) => Effect.Effect<ProgramArtifacts, E, R>,
  directory = "docs/modernization",
  options: ExtractProgramsOptions<E2, R2> = {}
): Effect.fn.Return<ResumeSummary, E | E2 | FlowError, R | R2> {
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 1))
  const halted = yield* Ref.make(false)

  const extractOne = (unit: ProgramUnit): Effect.Effect<Outcome, E | E2 | FlowError, R | R2> =>
    Effect.gen(function* () {
      if (yield* Ref.get(halted)) {
        return "not-started"
      }
      const [specPath, featurePath, traceabilityPath, mappingPath] = programArtifactPaths(
        unit,
        directory
      )
      if (
        specPath === undefined ||
        featurePath === undefined ||
        traceabilityPath === undefined ||
        mappingPath === undefined
      ) {
        return "not-started"
      }
      if ((yield* files.read(specPath)) !== undefined) {
        return "skipped"
      }
      const artifacts = yield* extract(unit)
      yield* files.writeAtomic(specPath, artifacts.spec)
      yield* files.writeAtomic(featurePath, artifacts.feature)
      yield* files.writeAtomic(traceabilityPath, artifacts.traceability)
      yield* files.writeAtomic(mappingPath, artifacts.mapping)
      if (options.onCreated !== undefined) {
        yield* options.onCreated(unit)
      }
      return "created"
    })

  const outcomes = yield* Effect.forEach(
    units,
    (unit) =>
      Effect.result(extractOne(unit)).pipe(
        Effect.tap((outcome) => (Result.isFailure(outcome) ? Ref.set(halted, true) : Effect.void))
      ),
    { concurrency }
  )

  const firstFailure = outcomes.find(Result.isFailure)
  if (firstFailure !== undefined) {
    return yield* Effect.fail(firstFailure.failure)
  }
  const created: Array<string> = []
  const skipped: Array<string> = []
  for (const [index, outcome] of outcomes.entries()) {
    const unit = units[index]
    if (unit === undefined || Result.isFailure(outcome)) {
      continue
    }
    if (outcome.success === "created") {
      created.push(unit.name)
    } else if (outcome.success === "skipped") {
      skipped.push(unit.name)
    }
  }
  return ResumeSummary.make({ created, skipped })
})

export const generateVectorsResumably = Effect.fn(
  "@llm4ts/modernize/Artifacts.generateVectorsResumably"
)(function* <E, R>(
  files: PlainFileStoreShape,
  programs: ReadonlyArray<string>,
  generate: (program: string) => Effect.Effect<string, E, R>,
  directory = "docs/modernization/vectors"
): Effect.fn.Return<ResumeSummary, E | FlowError, R> {
  const created: Array<string> = []
  const skipped: Array<string> = []
  for (const program of programs) {
    const path = `${directory}/${program}.jsonl`
    if ((yield* files.read(path)) !== undefined) {
      skipped.push(program)
      continue
    }
    yield* files.writeAtomic(path, yield* generate(program))
    created.push(program)
  }
  return ResumeSummary.make({ created, skipped })
})
