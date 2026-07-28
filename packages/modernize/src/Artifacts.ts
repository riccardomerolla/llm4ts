import * as Effect from "effect/Effect"
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

export const extractProgramsResumably = Effect.fn(
  "@llm4ts/modernize/Artifacts.extractProgramsResumably"
)(function* <E, R>(
  files: PlainFileStoreShape,
  units: ReadonlyArray<ProgramUnit>,
  extract: (unit: ProgramUnit) => Effect.Effect<ProgramArtifacts, E, R>,
  directory = "docs/modernization"
): Effect.fn.Return<ResumeSummary, E | FlowError, R> {
  const created: Array<string> = []
  const skipped: Array<string> = []
  for (const unit of units) {
    const specPath = `${directory}/specs/${unit.name}.md`
    if ((yield* files.read(specPath)) !== undefined) {
      skipped.push(unit.name)
      continue
    }
    const artifacts = yield* extract(unit)
    yield* files.writeAtomic(specPath, artifacts.spec)
    yield* files.writeAtomic(
      `${directory}/features/${programName(unit.name)}.feature`,
      artifacts.feature
    )
    yield* files.writeAtomic(`${directory}/traceability/${unit.name}.md`, artifacts.traceability)
    yield* files.writeAtomic(`${directory}/mapping/${unit.name}.md`, artifacts.mapping)
    created.push(unit.name)
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
