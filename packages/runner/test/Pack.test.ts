import { assert, describe, it } from "@effect/vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Effect from "effect/Effect"
import { appendPackLesson, loadPack } from "@llm4ts/flow/Pack"
import { makeNodeWorkspace } from "@llm4ts/runner/NodeWorkspace"

const temporaryDirectory = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "llm4ts-pack-"))),
  (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true }))
)

describe("modernization packs", () => {
  it.effect("loads manifest fields, gates, dimensions, rules, sidecars, and lessons", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporaryDirectory
        const workspace = yield* makeNodeWorkspace(root)
        yield* workspace.write(
          "pack/pack.md",
          `# Pack: cobol-springboot

source: cobol
scaffold: fixtures/spring
sources: .*\\.cbl
replay: node replay.mjs

## Gates

- build: pnpm build
- test: pnpm test

## Judge

- completeness (0..2): Every rule appears.

## Coverage: paragraph

files: .*\\.cbl
unit: ^([A-Z-]+)\\.

## Survey: calls

files: .*\\.cbl
unit: CALL '([^']+)'

## Equivalence

- ordering: per-key
- ignore: timestamp, requestId
`
        )
        yield* workspace.write("pack/prompts/spec.md", "Write the spec.\n")
        yield* workspace.write(
          "pack/reviewers/security.md",
          "---\nfiles: .*\\.java\n---\nReview security."
        )
        yield* workspace.write("pack/lessons.md", "Prefer decimal money.\n")
        const pack = yield* loadPack(workspace, "pack")
        yield* appendPackLesson(workspace, "pack", "Keep ids stable.")
        const lessons = yield* workspace.read("pack/lessons.md")

        assert.strictEqual(pack.name, "cobol-springboot")
        assert.strictEqual(pack.source, "cobol")
        assert.deepStrictEqual(pack.gate("build"), ["pnpm", "build"])
        assert.strictEqual(pack.judgeDimensions[0]?.maxScore, 2)
        assert.strictEqual(pack.coverage[0]?.name, "paragraph")
        assert.strictEqual(pack.survey[0]?.name, "calls")
        assert.strictEqual(pack.prompt("spec"), "Write the spec.")
        assert.isTrue(pack.lenses[0]?.matches(["src/App.java"]))
        assert.isFalse(pack.lenses[0]?.matches(["README.md"]))
        assert.strictEqual(pack.equivalence.ordering, "PerKey")
        assert.isTrue(pack.equivalence.ignore.has("timestamp"))
        assert.match(lessons, /Keep ids stable/)
      })
    )
  )
})
