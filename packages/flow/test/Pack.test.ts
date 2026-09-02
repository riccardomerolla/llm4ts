import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { appendPackLesson, loadPack } from "@llm4ts/flow/Pack"
import { makeMemoryWorkspace } from "@llm4ts/flow/Workspace"

describe("modernization packs", () => {
  it.effect("loads manifest fields, gates, dimensions, rules, sidecars, and lessons", () =>
    Effect.gen(function* () {
      const workspace = yield* makeMemoryWorkspace()
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
      // No programFiles template: filesFor falls back to a case-insensitive
      // name match with regex metacharacters escaped.
      assert.strictEqual(pack.programFiles, undefined)
      assert.isTrue(pack.filesFor("payroll").test("src/main/java/PAYROLL.java"))
      assert.isFalse(pack.filesFor("payroll").test("src/main/java/Billing.java"))
      assert.isFalse(pack.filesFor("pay.roll").test("src/payQroll.java"))
    })
  )

  it.effect("substitutes <NAME> into the programFiles template", () =>
    Effect.gen(function* () {
      const workspace = yield* makeMemoryWorkspace()
      yield* workspace.write(
        "pack/pack.md",
        `# Pack: cobol-springboot

source: cobol
programFiles: src/main/java/.*<NAME>.*\\.java
`
      )
      const pack = yield* loadPack(workspace, "pack")
      assert.strictEqual(pack.programFiles, "src/main/java/.*<NAME>.*\\.java")
      assert.isTrue(pack.filesFor("Payroll").test("src/main/java/PayrollService.java"))
      assert.isFalse(pack.filesFor("Payroll").test("src/main/java/Billing.java"))
      // The template is used verbatim: unlike the fallback it is case-sensitive.
      assert.isFalse(pack.filesFor("Payroll").test("src/main/java/PAYROLL.java"))
    })
  )

  it.effect("rejects an invalid programFiles regex template at load time", () =>
    Effect.gen(function* () {
      const workspace = yield* makeMemoryWorkspace()
      yield* workspace.write(
        "pack/pack.md",
        `# Pack: broken

source: cobol
programFiles: src/(<NAME>
`
      )
      const error = yield* Effect.flip(loadPack(workspace, "pack"))
      assert.strictEqual(error._tag, "PlanParse")
      assert.include(error.message, "programFiles")
    })
  )

  it.effect("reads an optional exclude regex and rejects an invalid one at load time", () =>
    Effect.gen(function* () {
      const workspace = yield* makeMemoryWorkspace()
      yield* workspace.write("none/pack.md", "# Pack: plain\n\nsource: jsp\n")
      assert.strictEqual((yield* loadPack(workspace, "none")).exclude, undefined)

      yield* workspace.write(
        "pack/pack.md",
        `# Pack: j2ee

source: jsp
sources: .*\\.(jsp|java|xml)
exclude: ^(vendor|generated)/
`
      )
      assert.strictEqual((yield* loadPack(workspace, "pack")).exclude, "^(vendor|generated)/")

      yield* workspace.write("broken/pack.md", "# Pack: broken\n\nsource: jsp\nexclude: ^(vendor\n")
      const error = yield* Effect.flip(loadPack(workspace, "broken"))
      assert.strictEqual(error._tag, "PlanParse")
      assert.include(error.message, "exclude")
    })
  )
})
