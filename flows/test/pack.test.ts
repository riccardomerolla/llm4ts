import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { loadPatternCards, matchingPatternCards } from "@llm4ts/flow/Patterns"
import { loadPack } from "@llm4ts/flow/Pack"
import { makeNodeWorkspace } from "@llm4ts/runner/NodeWorkspace"

const flowsRoot = join(dirname(fileURLToPath(import.meta.url)), "..")

const workspace = Effect.suspend(() => makeNodeWorkspace(flowsRoot))

/**
 * The shipped reference pack is the modernization flows' default configuration
 * (`LLM4TS_PACK`, resolved against the launch directory). These checks fail
 * loudly if an edit breaks the manifest the flows depend on — no network, no
 * provider, just the parser.
 */
describe("flows/packs/cobol-springboot", () => {
  it.effect("loads with the fields the modernization flows read", () =>
    Effect.gen(function* () {
      const pack = yield* loadPack(yield* workspace, "packs/cobol-springboot")

      assert.strictEqual(pack.name, "cobol-springboot")
      assert.strictEqual(pack.source, "cobol")
      assert.isDefined(pack.sources, "modernize-verify's clean-room wall needs a sources regex")
      assert.isDefined(pack.programs, "modernize-extract enumerates programs with this regex")
      assert.isDefined(pack.scaffold, "modernize-seed scaffolds an empty target from the pack")
      assert.isDefined(pack.replay, "modernize-verify replays vectors through this command")
      assert.strictEqual(pack.specsDir, "docs/specs")
      assert.strictEqual(pack.featuresDir, "src/test/resources/features")
    })
  )

  it.effect("declares the gates, judge rubric, and coverage rules the phases consume", () =>
    Effect.gen(function* () {
      const pack = yield* loadPack(yield* workspace, "packs/cobol-springboot")

      // modernize-implement picks build for the tests task and test/verify after.
      for (const gate of ["build", "test", "verify"]) {
        assert.isDefined(pack.gate(gate), `pack is missing the '${gate}' gate`)
      }
      // modernize-extract requires full marks on every dimension.
      assert.isAbove(pack.judgeDimensions.length, 0)
      for (const dimension of pack.judgeDimensions) {
        assert.isAbove(dimension.maxScore, 0)
        assert.isAbove(dimension.rubric.length, 0)
      }
      // Coverage rules drive the deterministic traceability gate; survey rules
      // drive the dependency graph.
      assert.deepStrictEqual(
        pack.coverage.map((rule) => rule.name),
        ["cobol-paragraph", "jcl-step"]
      )
      assert.deepStrictEqual(
        pack.survey.map((rule) => rule.name),
        ["calls", "copies", "exec-pgm"]
      )
      for (const rule of [...pack.coverage, ...pack.survey]) {
        assert.doesNotThrow(() => new RegExp(rule.files), `bad files regex in ${rule.name}`)
        assert.doesNotThrow(() => new RegExp(rule.unit), `bad unit regex in ${rule.name}`)
      }
    })
  )

  it.effect("carries every prompt sidecar the phases inject", () =>
    Effect.gen(function* () {
      const pack = yield* loadPack(yield* workspace, "packs/cobol-springboot")
      for (const name of ["analysis", "spec", "bdd", "plan", "implement", "review", "vectors"]) {
        const prompt = pack.prompt(name)
        assert.isDefined(prompt, `pack is missing the '${name}' prompt`)
        assert.isAbove(prompt?.length ?? 0, 0)
      }
      assert.isAbove(pack.lenses.length, 0, "pack ships reviewer lenses for the review phase")
    })
  )

  it.effect("matches its coverage regexes against representative COBOL and JCL", () =>
    Effect.gen(function* () {
      const pack = yield* loadPack(yield* workspace, "packs/cobol-springboot")
      const paragraph = pack.coverage.find((rule) => rule.name === "cobol-paragraph")
      const step = pack.coverage.find((rule) => rule.name === "jcl-step")

      assert.match("       0100-VALIDATE-INPUT.", new RegExp(paragraph?.unit ?? "$^"))
      assert.match("//STEP010  EXEC PGM=ACCTXFR", new RegExp(step?.unit ?? "$^"))
    })
  )
})

describe("flows/patterns", () => {
  it.effect("loads the universal pattern cards with usable match regexes", () =>
    Effect.gen(function* () {
      const cards = yield* loadPatternCards(yield* workspace, "patterns")
      assert.isAbove(cards.length, 0)
      for (const card of cards) {
        assert.match(card.id, /^PAT-/, "cards are cited by a PAT- id in tagged specs")
        assert.isAbove(card.body.length, 0, `${card.id} has an empty body`)
        assert.doesNotThrow(() => new RegExp(card.matches, "m"), `${card.id} has a bad regex`)
      }
    })
  )

  it.effect("selects the packed-decimal card for COMP-3 source", () =>
    Effect.gen(function* () {
      const cards = yield* loadPatternCards(yield* workspace, "patterns")
      const matched = matchingPatternCards("       01  WS-AMOUNT   PIC S9(7)V99 COMP-3.", cards)
      assert.isAbove(matched.length, 0, "no pattern card matched a COMP-3 declaration")
    })
  )
})
