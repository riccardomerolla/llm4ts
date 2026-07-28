import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { ParseError, ProviderError } from "@llm4ts/core/Errors"
import { jsonCandidates, parseFromText, withSchemaHint } from "@llm4ts/core/StructuredOutput"

class TriagePick extends Schema.Class<TriagePick>("TriagePick")({
  lane: Schema.String,
  note: Schema.String
}) {}

const emptySchema = {}

describe("StructuredOutput", () => {
  it.effect("decodes a plain JSON object", () =>
    Effect.gen(function* () {
      const pick = yield* parseFromText(
        '{"lane":"Frontend","note":"safari"}',
        TriagePick,
        emptySchema
      )

      assert.deepStrictEqual(pick, TriagePick.make({ lane: "Frontend", note: "safari" }))
    })
  )

  it.effect("extracts JSON from a fenced block surrounded by chatter", () =>
    Effect.gen(function* () {
      const pick = yield* parseFromText(
        `Here is your answer:

\`\`\`json
{"lane":"Backend","note":"db"}
\`\`\`

Hope that helps!`,
        TriagePick,
        emptySchema
      )

      assert.deepStrictEqual(pick, TriagePick.make({ lane: "Backend", note: "db" }))
    })
  )

  it.effect("recovers from a CLI warning prepended to JSON", () =>
    Effect.gen(function* () {
      const pick = yield* parseFromText(
        `Warning: no stdin data received in 3s, proceeding without it.
{"lane":"Custom","note":"docs-readme-update"}`,
        TriagePick,
        emptySchema
      )

      assert.strictEqual(pick.lane, "Custom")
      assert.strictEqual(pick.note, "docs-readme-update")
    })
  )

  it.effect("reports the most deeply extracted JSON candidate", () =>
    Effect.gen(function* () {
      const raw = `Warning: nope.
{"wrong":"shape"}`
      const error = yield* Effect.flip(parseFromText(raw, TriagePick, emptySchema))

      assert.instanceOf(error, ParseError)
      assert.match(error.message, /"wrong":"shape"/)
      assert.match(error.message, /tried 2 candidate/)
      assert.strictEqual(error.raw, raw)
    })
  )

  it.effect("classifies blank output as a retryable provider failure", () =>
    Effect.gen(function* () {
      const empty = yield* Effect.flip(parseFromText("", TriagePick, emptySchema))
      const blank = yield* Effect.flip(parseFromText(" \n\t ", TriagePick, emptySchema))

      assert.instanceOf(empty, ProviderError)
      assert.instanceOf(blank, ProviderError)
      assert.match(empty.message, /empty response/)
    })
  )

  it("finds balanced objects after preambles and respects quoted braces", () => {
    const candidates = jsonCandidates(
      `noise {"a":{"text":"a } brace","nested":{"ok":true}}} more {"b":2}`
    )

    assert.include(candidates, '{"a":{"text":"a } brace","nested":{"ok":true}}}')
    assert.include(candidates, '{"b":2}')
  })

  it("deduplicates raw, fenced, and balanced candidates", () => {
    const raw = `\`\`\`json
{"lane":"Backend","note":"db"}
\`\`\``
    const candidates = jsonCandidates(raw)

    assert.strictEqual(
      candidates.filter((candidate) => candidate === '{"lane":"Backend","note":"db"}').length,
      1
    )
  })

  it("appends only non-trivial schema hints", () => {
    assert.strictEqual(withSchemaHint("go", {}), "go")

    const schema = {
      type: "object",
      properties: {
        lane: { type: "string" }
      }
    }
    const hinted = withSchemaHint("do it", schema)

    assert.match(hinted, /^do it/)
    assert.include(hinted, "Return JSON matching this schema:")
    assert.include(hinted, JSON.stringify(schema))
  })
})
