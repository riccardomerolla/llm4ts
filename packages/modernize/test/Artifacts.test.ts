import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import type { PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import {
  extractProgramsResumably,
  generateVectorsResumably,
  ProgramArtifacts,
  ProgramUnit
} from "@llm4ts/modernize/Artifacts"

const memoryFiles = (state: Ref.Ref<Readonly<Record<string, string>>>): PlainFileStoreShape => ({
  read: (path) => Ref.get(state).pipe(Effect.map((files) => files[path])),
  writeAtomic: (path, contents) => Ref.update(state, (files) => ({ ...files, [path]: contents })),
  append: (path, contents) =>
    Ref.update(state, (files) => ({ ...files, [path]: `${files[path] ?? ""}${contents}` })),
  remove: (path) =>
    Ref.update(state, (files) =>
      Object.fromEntries(Object.entries(files).filter(([candidate]) => candidate !== path))
    ),
  hashSha256: (_path) => Effect.succeed("")
})

describe("modernize artifact resume", () => {
  it.effect("skips programs whose specification already exists", () =>
    Effect.gen(function* () {
      const disk = yield* Ref.make<Readonly<Record<string, string>>>({
        "docs/modernization/specs/ACCT.md": "existing"
      })
      const calls = yield* Ref.make<ReadonlyArray<string>>([])
      const summary = yield* extractProgramsResumably(
        memoryFiles(disk),
        [
          ProgramUnit.make({ name: "ACCT", sourcePath: "legacy/ACCT.cbl" }),
          ProgramUnit.make({ name: "XFER", sourcePath: "legacy/XFER.cbl" })
        ],
        (unit) =>
          Ref.update(calls, (current) => [...current, unit.name]).pipe(
            Effect.as(
              ProgramArtifacts.make({
                spec: `spec ${unit.name}`,
                feature: `feature ${unit.name}`,
                traceability: `trace ${unit.name}`,
                mapping: `mapping ${unit.name}`
              })
            )
          )
      )
      const files = yield* Ref.get(disk)

      assert.deepStrictEqual(summary.created, ["XFER"])
      assert.deepStrictEqual(summary.skipped, ["ACCT"])
      assert.deepStrictEqual(yield* Ref.get(calls), ["XFER"])
      assert.strictEqual(files["docs/modernization/features/xfer.feature"], "feature XFER")
    })
  )

  it.effect("skips existing vectors and generates only missing programs", () =>
    Effect.gen(function* () {
      const disk = yield* Ref.make<Readonly<Record<string, string>>>({
        "docs/modernization/vectors/ACCT.jsonl": "{}\n"
      })
      const calls = yield* Ref.make<ReadonlyArray<string>>([])
      const summary = yield* generateVectorsResumably(
        memoryFiles(disk),
        ["ACCT", "XFER"],
        (program) =>
          Ref.update(calls, (current) => [...current, program]).pipe(
            Effect.as(`{"program":"${program}"}\n`)
          )
      )

      assert.deepStrictEqual(summary.created, ["XFER"])
      assert.deepStrictEqual(summary.skipped, ["ACCT"])
      assert.deepStrictEqual(yield* Ref.get(calls), ["XFER"])
    })
  )
})
