import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { loadPack, type Pack } from "@llm4ts/flow/Pack"
import { loadPatternCards, matchingPatternCards } from "@llm4ts/flow/Patterns"
import { makeNodeWorkspace } from "@llm4ts/runner/NodeWorkspace"

const flowsRoot = join(dirname(fileURLToPath(import.meta.url)), "..")

const workspace = Effect.suspend(() => makeNodeWorkspace(flowsRoot))

const load = (name: string): Effect.Effect<Pack, unknown> =>
  Effect.flatMap(workspace, (space) => loadPack(space, `packs/${name}`))

/**
 * The shipped reference packs are the modernization flows' default
 * configuration (`LLM4TS_PACK`, resolved against the launch directory).
 * These checks fail loudly if an edit breaks a manifest the flows depend on —
 * no network, no provider, just the parser.
 */
const packs = [
  {
    name: "cobol-springboot",
    source: "cobol",
    specsDir: "docs/specs",
    featuresDir: "src/test/resources/features",
    coverage: ["cobol-paragraph", "jcl-step"],
    survey: ["calls", "copies", "exec-pgm"],
    replay: true
  },
  {
    name: "cobol-kafka",
    source: "cobol",
    specsDir: "docs/specs",
    featuresDir: "src/test/resources/features",
    coverage: ["cobol-paragraph", "jcl-step"],
    survey: ["calls", "copies", "exec-pgm"],
    replay: true
  },
  {
    name: "ace-integration",
    source: "ace",
    specsDir: "docs/specs",
    featuresDir: "src/test/resources/features",
    replay: false
  },
  {
    name: "ace-kafka",
    source: "ace",
    specsDir: "docs/specs",
    featuresDir: "src/test/resources/features",
    replay: true
  },
  {
    name: "jsp-bff-nextjs",
    source: "jsp",
    specsDir: "docs/specs",
    featuresDir: "src/test/resources/features",
    replay: false
  },
  {
    name: "jsp-nextjs",
    source: "jsp",
    specsDir: "docs/specs",
    featuresDir: "features",
    replay: false
  },
  {
    name: "j2ee-nextjs-spa",
    source: "jsp",
    specsDir: "docs/modernization/specs",
    featuresDir: "docs/modernization/features",
    coverage: ["servlet-url", "jsp-form", "jsp-ajax"],
    survey: ["jsp-include", "servlet-class"],
    replay: false
  }
] as const

describe.each(packs)("flows/packs/$name", (expected) => {
  it.effect("loads with the fields the modernization flows read", () =>
    Effect.gen(function* () {
      const pack = yield* load(expected.name)

      assert.strictEqual(pack.name, expected.name)
      assert.strictEqual(pack.source, expected.source)
      assert.strictEqual(pack.specsDir, expected.specsDir)
      assert.strictEqual(pack.featuresDir, expected.featuresDir)
      // Every target-side phase gates on the wall, which needs this regex.
      assert.isDefined(pack.sources, "the clean-room wall needs a sources regex")
      assert.doesNotThrow(() => new RegExp(pack.sources ?? ""))
      // modernize-seed scaffolds an empty target from the pack.
      assert.isDefined(pack.scaffold, "modernize-seed needs a scaffold")
    })
  )

  it.effect("points at a scaffold that ships with the repository", () =>
    Effect.gen(function* () {
      const pack = yield* load(expected.name)
      const scaffold = resolve(flowsRoot, "packs", expected.name, pack.scaffold ?? "")
      assert.isTrue(existsSync(scaffold), `missing scaffold for ${expected.name}: ${scaffold}`)
      // The seeded target must be able to run the pack's own replay command.
      if (pack.replay !== undefined) {
        const script = pack.replay.find((part) => part.endsWith(".sh"))
        if (script !== undefined) {
          assert.isTrue(
            existsSync(join(scaffold, script)),
            `${expected.name} declares 'replay: ${script}' but its scaffold does not ship it`
          )
        }
      }
    })
  )

  it.effect("declares the gates and judge rubric the phases consume", () =>
    Effect.gen(function* () {
      const pack = yield* load(expected.name)
      // modernize-implement gates each task on build, then test/verify.
      assert.isDefined(pack.gate("build"), `${expected.name} is missing the 'build' gate`)
      assert.isDefined(pack.gate("test"), `${expected.name} is missing the 'test' gate`)
      // modernize-extract requires full marks on every dimension.
      assert.isAbove(pack.judgeDimensions.length, 0)
      for (const dimension of pack.judgeDimensions) {
        assert.isAbove(dimension.maxScore, 0)
        assert.isAbove(dimension.rubric.length, 0)
      }
    })
  )

  it.effect("carries compilable coverage and survey rules", () =>
    Effect.gen(function* () {
      const pack = yield* load(expected.name)
      if ("coverage" in expected) {
        assert.deepStrictEqual(
          pack.coverage.map((rule) => rule.name),
          [...expected.coverage]
        )
      }
      if ("survey" in expected) {
        assert.deepStrictEqual(
          pack.survey.map((rule) => rule.name),
          [...expected.survey]
        )
      }
      // Coverage feeds the traceability gate; survey feeds the dependency graph.
      assert.isAbove(pack.coverage.length, 0, "no coverage rules — the gate would pass vacuously")
      for (const rule of [...pack.coverage, ...pack.survey]) {
        assert.doesNotThrow(() => new RegExp(rule.files), `bad files regex in ${rule.name}`)
        assert.doesNotThrow(() => new RegExp(rule.unit), `bad unit regex in ${rule.name}`)
      }
    })
  )

  it.effect("carries the prompt sidecars and reviewer lenses the phases inject", () =>
    Effect.gen(function* () {
      const pack = yield* load(expected.name)
      // These four are read by extract (analysis/spec/bdd/plan); implement and
      // review read their own, and verify reads vectors when it has one.
      for (const name of ["analysis", "spec", "bdd", "plan", "implement", "review"]) {
        const prompt = pack.prompt(name)
        assert.isDefined(prompt, `${expected.name} is missing the '${name}' prompt`)
        assert.isAbove(prompt?.length ?? 0, 0)
      }
      if (expected.replay) {
        assert.isDefined(
          pack.prompt("vectors"),
          `${expected.name} replays vectors but ships no 'vectors' prompt`
        )
      }
      // A pack that can be surveyed (it has edge rules) owns the wording of
      // the survey's two reasoning prompts; the flow's frame names no stack,
      // so without these the model would triage a J2EE estate blind.
      if (pack.survey.length > 0) {
        for (const name of ["survey-refine", "survey-triage"]) {
          const prompt = pack.prompt(name) ?? ""
          assert.isAbove(prompt.length, 0, `${expected.name} is missing the '${name}' prompt`)
          if (expected.source !== "cobol") {
            assert.notMatch(prompt, /COBOL|JCL|copybook/i, `${name} in ${expected.name}`)
          }
        }
      }
      assert.isAbove(pack.lenses.length, 0, "packs ship reviewer lenses for the review phase")
      for (const lens of pack.lenses) {
        assert.isAbove(lens.systemPrompt.length, 0, `${lens.name} has an empty prompt`)
        if (lens.files !== undefined) {
          assert.doesNotThrow(() => new RegExp(lens.files ?? ""), `bad files regex in ${lens.name}`)
        }
      }
    })
  )
})

describe("cobol coverage rules", () => {
  it.effect("match representative COBOL paragraphs and JCL steps", () =>
    Effect.gen(function* () {
      const pack = yield* load("cobol-springboot")
      const paragraph = pack.coverage.find((rule) => rule.name === "cobol-paragraph")
      const step = pack.coverage.find((rule) => rule.name === "jcl-step")

      assert.match("       0100-VALIDATE-INPUT.", new RegExp(paragraph?.unit ?? "$^"))
      assert.match("//STEP010  EXEC PGM=ACCTXFR", new RegExp(step?.unit ?? "$^"))
    })
  )
})

describe("pattern cards", () => {
  it.effect("load from the universal directory with usable match regexes", () =>
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

  it.effect("load from a pack-local directory too", () =>
    Effect.gen(function* () {
      const cards = yield* loadPatternCards(yield* workspace, "packs/cobol-kafka/patterns")
      assert.isAbove(cards.length, 0, "cobol-kafka ships its own event-streaming cards")
      for (const card of cards) {
        assert.doesNotThrow(() => new RegExp(card.matches, "m"), `${card.id} has a bad regex`)
      }
    })
  )

  it.effect("select the packed-decimal card for COMP-3 source", () =>
    Effect.gen(function* () {
      const cards = yield* loadPatternCards(yield* workspace, "patterns")
      const matched = matchingPatternCards("       01  WS-AMOUNT   PIC S9(7)V99 COMP-3.", cards)
      assert.isAbove(matched.length, 0, "no pattern card matched a COMP-3 declaration")
    })
  )
})
