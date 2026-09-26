import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { parseYaml, renderYaml, yamlScalar } from "../flows/lib/soap/Yaml.ts"

describe("Yaml subset", () => {
  it.effect("reads mappings, sequences, comments, and keeps every scalar a string", () =>
    Effect.gen(function* () {
      const value = yield* parseYaml(
        [
          "# request",
          "operation: cercaMovimenti   # trailing comment",
          "purpose: 'happy path: one page'",
          "body:",
          "  iban: IT60X0542811101000000123456",
          "  codice: 0012",
          "  flag: no",
          '  nota: "a # not a comment"',
          "  vuoto:",
          "  nil: ~",
          "  lista:",
          "    - uno",
          "    - due",
          "  conti:",
          "  - iban: A",
          "    stato: ATTIVO",
          "  -",
          "    iban: B",
          '  "@versione": "2"',
          "  empty: []"
        ].join("\n")
      )
      assert.deepStrictEqual(value, {
        operation: "cercaMovimenti",
        purpose: "happy path: one page",
        body: {
          iban: "IT60X0542811101000000123456",
          codice: "0012",
          flag: "no",
          nota: "a # not a comment",
          vuoto: null,
          nil: null,
          lista: ["uno", "due"],
          conti: [{ iban: "A", stato: "ATTIVO" }, { iban: "B" }],
          "@versione": "2",
          empty: []
        }
      })
    })
  )

  it.effect("reads literal and folded block scalars", () =>
    Effect.gen(function* () {
      const value = yield* parseYaml(
        "a: |\n  riga 1\n  # kept\n\n  riga 3\nb: >-\n  one\n  two\nc: x\n"
      )
      assert.deepStrictEqual(value, { a: "riga 1\n# kept\n\nriga 3\n", b: "one two", c: "x" })
    })
  )

  it.effect("refuses tabs, duplicates, anchors, and bad indentation with a line number", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* Effect.flip(parseYaml("a:\n\tb: 1"))).line, 2)
      assert.include((yield* Effect.flip(parseYaml("a: 1\na: 2"))).detail, "duplicate")
      assert.include((yield* Effect.flip(parseYaml("a: &x 1"))).detail, "unsupported")
      assert.strictEqual((yield* Effect.flip(parseYaml("a: 1\n   b: 2"))).line, 2)
    })
  )

  it.effect("round-trips rendered values, quoting what plain YAML would change", () =>
    Effect.gen(function* () {
      const value = {
        a: "",
        b: " padded ",
        c: "k: v",
        d: "- dash",
        e: "null",
        f: "multi\nline",
        g: ["x", { h: "y", i: [] }],
        "@attr": "1",
        n: null
      }
      assert.deepStrictEqual(yield* parseYaml(renderYaml(value)), value)
      assert.strictEqual(yamlScalar("IT60X0542811101000000123456"), "IT60X0542811101000000123456")
    })
  )
})
