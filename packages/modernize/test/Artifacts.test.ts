import { assert, describe, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import type { PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import {
  extractProgramsResumably,
  generateVectorsResumably,
  programArtifactPaths,
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

  // `it.live`: the sequential half is proved by a real timeout, which the
  // test clock `it.effect` provides would never let fire.
  it.live("runs programs concurrently under the bound and sequentially without it", () =>
    Effect.gen(function* () {
      // A extracts only once B has STARTED: with concurrency 2 that is a
      // handshake, with concurrency 1 it is a deadlock the timeout exposes.
      const units = [
        ProgramUnit.make({ name: "A", sourcePath: "legacy/A.cbl" }),
        ProgramUnit.make({ name: "B", sourcePath: "legacy/B.cbl" })
      ]
      const artifacts = (unit: ProgramUnit) =>
        ProgramArtifacts.make({ spec: unit.name, feature: "", traceability: "", mapping: "" })
      const run = (concurrency: number) =>
        Effect.gen(function* () {
          const disk = yield* Ref.make<Readonly<Record<string, string>>>({})
          const bStarted = yield* Deferred.make<void>()
          const summary = yield* extractProgramsResumably(
            memoryFiles(disk),
            units,
            (unit) =>
              unit.name === "A"
                ? Deferred.await(bStarted).pipe(Effect.as(artifacts(unit)))
                : Deferred.succeed(bStarted, undefined).pipe(Effect.as(artifacts(unit))),
            "docs/modernization",
            { concurrency }
          ).pipe(Effect.timeoutOption(Duration.millis(200)))
          return summary
        })

      const parallel = yield* run(2)
      assert.isTrue(Option.isSome(parallel), "two programs should overlap under concurrency 2")
      assert.deepStrictEqual(Option.getOrThrow(parallel).created, ["A", "B"])

      const sequential = yield* run(1)
      assert.isTrue(Option.isNone(sequential), "concurrency 1 must not start B before A ends")
    })
  )

  it.effect("runs onCreated per created program with its artifacts already on disk", () =>
    Effect.gen(function* () {
      const disk = yield* Ref.make<Readonly<Record<string, string>>>({
        "docs/modernization/specs/OLD.md": "existing"
      })
      const seen = yield* Ref.make<ReadonlyArray<string>>([])
      const summary = yield* extractProgramsResumably(
        memoryFiles(disk),
        [
          ProgramUnit.make({ name: "OLD", sourcePath: "legacy/OLD.cbl" }),
          ProgramUnit.make({ name: "NEW", sourcePath: "legacy/NEW.cbl" })
        ],
        (unit) =>
          Effect.succeed(
            ProgramArtifacts.make({
              spec: `spec ${unit.name}`,
              feature: "f",
              traceability: "t",
              mapping: "m"
            })
          ),
        "docs/modernization",
        {
          concurrency: 4,
          onCreated: (unit) =>
            Effect.gen(function* () {
              const files = yield* Ref.get(disk)
              for (const path of programArtifactPaths(unit)) {
                assert.isDefined(files[path], `${path} should exist before onCreated`)
              }
              yield* Ref.update(seen, (current) => [...current, unit.name])
            })
        }
      )
      assert.deepStrictEqual(summary.created, ["NEW"])
      assert.deepStrictEqual(summary.skipped, ["OLD"])
      assert.deepStrictEqual(yield* Ref.get(seen), ["NEW"])
    })
  )

  it.effect("lets in-flight programs finish on a failure, then re-raises the first one", () =>
    Effect.gen(function* () {
      const disk = yield* Ref.make<Readonly<Record<string, string>>>({})
      const committed = yield* Ref.make<ReadonlyArray<string>>([])
      const release = yield* Deferred.make<void>()
      const cStarted = yield* Deferred.make<void>()
      const units = ["A", "B", "C", "D"].map((name) =>
        ProgramUnit.make({ name, sourcePath: `legacy/${name}.cbl` })
      )
      // A, B, C start together (B waits until C has started, so all three are
      // genuinely in flight); B then releases the others and fails. A and C
      // must land; D was never started because B's failure halted scheduling
      // before a slot freed up.
      const finish = (unit: ProgramUnit) =>
        Deferred.await(release).pipe(
          Effect.as(
            ProgramArtifacts.make({ spec: unit.name, feature: "", traceability: "", mapping: "" })
          )
        )
      const failure = yield* Effect.flip(
        extractProgramsResumably(
          memoryFiles(disk),
          units,
          (unit) =>
            unit.name === "B"
              ? Deferred.await(cStarted).pipe(
                  Effect.andThen(Deferred.succeed(release, undefined)),
                  Effect.andThen(Effect.fail(new Error("quota")))
                )
              : unit.name === "C"
                ? Deferred.succeed(cStarted, undefined).pipe(Effect.andThen(finish(unit)))
                : finish(unit),
          "docs/modernization",
          {
            concurrency: 3,
            onCreated: (unit) => Ref.update(committed, (current) => [...current, unit.name])
          }
        )
      )
      assert.strictEqual(failure instanceof Error ? failure.message : "", "quota")
      const files = yield* Ref.get(disk)
      assert.isDefined(files["docs/modernization/specs/A.md"], "A was in flight and must land")
      assert.isDefined(files["docs/modernization/specs/C.md"], "C was in flight and must land")
      assert.isUndefined(
        files["docs/modernization/specs/D.md"],
        "D must not start after the failure"
      )
      assert.deepStrictEqual([...(yield* Ref.get(committed))].sort(), ["A", "C"])
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
