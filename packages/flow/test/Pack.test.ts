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
program-files: src/main/java/.*<NAME>.*\\.java
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

describe("2.0 manifest keys", () => {
  it.effect("refuses the pre-2.0 'programFiles:' spelling with the migration hint", () =>
    Effect.gen(function* () {
      const workspace = yield* makeMemoryWorkspace()
      yield* workspace.write(
        "packs/old/pack.md",
        "# Pack: old\n\nsource: cobol\nprogramFiles: src/.*<NAME>.*\n"
      )
      const error = yield* loadPack(workspace, "packs/old").pipe(Effect.flip)
      assert.strictEqual(error._tag, "PlanParse")
      assert.include(error.message, "renamed 'program-files:' in llm4ts 2.0")
    })
  )

  it.effect("reads '## Consolidate' cluster and context kinds and rejects unknown ones", () =>
    Effect.gen(function* () {
      const workspace = yield* makeMemoryWorkspace()
      const manifest = (consolidate: string): string =>
        `# Pack: jsp

source: jsp

## Survey: jsp-include

files: .*\\.jsp
unit: <jsp:include page="([^"]+)"

## Survey: jsp-form-action

files: .*\\.jsp
unit: action="([^"]+)"

## Consolidate

${consolidate}
`
      yield* workspace.write(
        "pack/pack.md",
        manifest("- cluster: jsp-form-action, llm-*\n- context: jsp-include")
      )
      const pack = yield* loadPack(workspace, "pack")
      assert.deepStrictEqual(pack.consolidate, {
        cluster: ["jsp-form-action", "llm-*"],
        context: ["jsp-include"]
      })

      yield* workspace.write("pack/pack.md", manifest("- cluster: servlet-class"))
      const unknown = yield* loadPack(workspace, "pack").pipe(Effect.flip)
      assert.include(
        unknown.message,
        "names edge kinds no '## Survey:' rule produces: servlet-class"
      )

      yield* workspace.write(
        "pack/pack.md",
        manifest("- cluster: jsp-include\n- context: jsp-include")
      )
      const both = yield* loadPack(workspace, "pack").pipe(Effect.flip)
      assert.include(both.message, "as both cluster and context")

      yield* workspace.write("pack/pack.md", "# Pack: bare\n\nsource: jsp\n")
      assert.strictEqual((yield* loadPack(workspace, "pack")).consolidate, undefined)
    })
  )

  it.effect("feature-files scopes a domain feature to its own paths plus its pages' scopes", () =>
    Effect.gen(function* () {
      const workspace = yield* makeMemoryWorkspace()
      yield* workspace.write(
        "pack/pack.md",
        [
          "# Pack: jsp",
          "",
          "source: jsp",
          "program-files: (?:src/app/<NAME>(?:/.*)?|tests/<NAME>\\..*)",
          "feature-files: (?:src/services/<NAME>(?:/.*)?|contracts/<NAME>\\.openapi\\.yaml)",
          ""
        ].join("\n")
      )
      const pack = yield* loadPack(workspace, "pack")
      const files = pack.filesForFeature("beneficiary-maintenance", [
        "beneficiaryList",
        "beneficiaryEdit"
      ])
      assert.isTrue(files.test("src/services/beneficiary-maintenance/port.ts"))
      assert.isTrue(files.test("contracts/beneficiary-maintenance.openapi.yaml"))
      assert.isTrue(files.test("src/app/beneficiaryEdit/page.tsx"))
      assert.isTrue(files.test("tests/beneficiaryList.page.test.tsx"))
      assert.isFalse(files.test("src/services/accounts/port.ts"))
      assert.isFalse(files.test("src/app/accountOverview/page.tsx"))

      yield* workspace.write("pack/pack.md", "# Pack: bad\n\nsource: jsp\nfeature-files: (<NAME>\n")
      const failure = yield* loadPack(workspace, "pack").pipe(Effect.flip)
      assert.include(failure.message, "'feature-files:' is not a valid regex template")
    })
  )
})
