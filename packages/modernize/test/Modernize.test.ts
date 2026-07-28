import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import { FlowAborted } from "@llm4ts/flow/FlowError"
import { saveVersioned, type PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import { ApprovedMarker } from "@llm4ts/modernize/Approval"
import { makeModernize, withModernizeApprovals } from "@llm4ts/modernize/Modernize"
import {
  CurrentModernizeStateVersion,
  ModernizeState,
  PhaseCheckpoint,
  PhaseOutcome,
  modernizePhases
} from "@llm4ts/modernize/Model"

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

const outcome = (phase: string): PhaseOutcome =>
  PhaseOutcome.make({ summary: `${phase} done`, artifacts: [] })

describe("Modernize", () => {
  it.effect("runs all six phases in order and persists their checkpoints", () =>
    Effect.gen(function* () {
      const disk = yield* Ref.make<Readonly<Record<string, string>>>({})
      const ran = yield* Ref.make<ReadonlyArray<string>>([])
      const phase = (name: string) =>
        Ref.update(ran, (current) => [...current, name]).pipe(Effect.as(outcome(name)))
      const modernize = makeModernize(memoryFiles(disk), {
        survey: phase("survey"),
        extract: phase("extract"),
        seed: phase("seed"),
        implement: phase("implement"),
        verify: phase("verify"),
        review: phase("review")
      })

      const state = yield* modernize.run({ project: "meridian" })
      const restored = yield* modernize.load()

      assert.deepStrictEqual(yield* Ref.get(ran), modernizePhases)
      assert.isTrue(state.completed)
      assert.deepStrictEqual(restored, state)
      assert.deepStrictEqual(
        state.checkpoints.map(({ status, attempts }) => ({ status, attempts })),
        modernizePhases.map(() => ({ status: "completed", attempts: 1 }))
      )
    })
  )

  it.effect("resumes a failed phase without rerunning completed predecessors", () =>
    Effect.gen(function* () {
      const disk = yield* Ref.make<Readonly<Record<string, string>>>({})
      const ran = yield* Ref.make<ReadonlyArray<string>>([])
      const failVerify = yield* Ref.make(true)
      const phase = (name: string) =>
        Ref.update(ran, (current) => [...current, name]).pipe(Effect.as(outcome(name)))
      const verify = Ref.get(failVerify).pipe(
        Effect.flatMap((fail) =>
          fail ? Effect.fail(FlowAborted.make({ message: "equivalence failed" })) : phase("verify")
        )
      )
      const modernize = makeModernize(memoryFiles(disk), {
        survey: phase("survey"),
        extract: phase("extract"),
        seed: phase("seed"),
        implement: phase("implement"),
        verify,
        review: phase("review")
      })

      const first = yield* Effect.result(modernize.run({ project: "meridian" }))
      const failed = yield* modernize.load()
      yield* Ref.set(failVerify, false)
      const resumed = yield* modernize.run({ project: "meridian" })

      assert.strictEqual(first._tag, "Failure")
      assert.strictEqual(failed?.checkpoint("verify").status, "failed")
      assert.deepStrictEqual(yield* Ref.get(ran), [
        "survey",
        "extract",
        "seed",
        "implement",
        "verify",
        "review"
      ])
      assert.strictEqual(resumed.checkpoint("verify").attempts, 2)
      assert.isTrue(resumed.completed)
    })
  )

  it.effect("runs only through the requested phase and continues later", () =>
    Effect.gen(function* () {
      const disk = yield* Ref.make<Readonly<Record<string, string>>>({})
      const ran = yield* Ref.make<ReadonlyArray<string>>([])
      const phase = (name: string) =>
        Ref.update(ran, (current) => [...current, name]).pipe(Effect.as(outcome(name)))
      const modernize = makeModernize(memoryFiles(disk), {
        survey: phase("survey"),
        extract: phase("extract"),
        seed: phase("seed"),
        implement: phase("implement"),
        verify: phase("verify"),
        review: phase("review")
      })

      const partial = yield* modernize.run({ project: "meridian", through: "seed" })
      const complete = yield* modernize.run({ project: "meridian" })

      assert.strictEqual(partial.checkpoint("implement").status, "pending")
      assert.deepStrictEqual(yield* Ref.get(ran), modernizePhases)
      assert.isTrue(complete.completed)
    })
  )

  it.effect("retries a running checkpoint left by process interruption", () =>
    Effect.gen(function* () {
      const disk = yield* Ref.make<Readonly<Record<string, string>>>({})
      const files = memoryFiles(disk)
      const ran = yield* Ref.make<ReadonlyArray<string>>([])
      yield* saveVersioned(
        files,
        "docs/modernization/state.json",
        CurrentModernizeStateVersion,
        ModernizeState,
        ModernizeState.make({
          project: "meridian",
          checkpoints: modernizePhases.map((phase, index) =>
            PhaseCheckpoint.make({
              phase,
              status: index === 0 ? "running" : "pending",
              attempts: index === 0 ? 1 : 0
            })
          )
        })
      )
      const phase = (name: string) =>
        Ref.update(ran, (current) => [...current, name]).pipe(Effect.as(outcome(name)))
      const modernize = makeModernize(files, {
        survey: phase("survey"),
        extract: phase("extract"),
        seed: phase("seed"),
        implement: phase("implement"),
        verify: phase("verify"),
        review: phase("review")
      })

      const state = yield* modernize.run({ project: "meridian", through: "survey" })

      assert.deepStrictEqual(yield* Ref.get(ran), ["survey"])
      assert.strictEqual(state.checkpoint("survey").status, "completed")
      assert.strictEqual(state.checkpoint("survey").attempts, 2)
    })
  )

  it.effect("enforces the wave and specification-pack human gates", () =>
    Effect.gen(function* () {
      const disk = yield* Ref.make<Readonly<Record<string, string>>>({
        "docs/modernization/wave-plan.md": `waves\n\n${ApprovedMarker}\n`,
        "docs/modernization/README.md": "- [ ] Approved\n"
      })
      const files = memoryFiles(disk)
      const handlers = withModernizeApprovals(
        files,
        {
          wavePlan: "docs/modernization/wave-plan.md",
          specificationPack: "docs/modernization/README.md"
        },
        {
          survey: Effect.succeed(outcome("survey")),
          extract: Effect.succeed(outcome("extract")),
          seed: Effect.succeed(outcome("seed")),
          implement: Effect.succeed(outcome("implement")),
          verify: Effect.succeed(outcome("verify")),
          review: Effect.succeed(outcome("review"))
        }
      )
      const modernize = makeModernize(files, handlers)

      const blocked = yield* Effect.result(modernize.run({ project: "meridian" }))
      assert.strictEqual(
        blocked._tag === "Failure" ? blocked.failure._tag : undefined,
        "ApprovalRequired"
      )
      assert.strictEqual((yield* modernize.load())?.checkpoint("seed").status, "failed")
    })
  )
})
