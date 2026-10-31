import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { parsePersona, renderPersona } from "@llm4ts/flow/Roundtable"
import {
  bundledSpecialistCards,
  bundledSpecialists,
  chiefName,
  memoryName,
  selectableSpecialists,
  writerName
} from "../lib/taskforce-personas.ts"

describe("bundled specialists (ADR 0047)", () => {
  it.effect("every bundled card parses, and renders back to itself", () =>
    Effect.gen(function* () {
      for (const [name, card] of Object.entries(bundledSpecialistCards)) {
        const persona = yield* parsePersona(name, card)
        assert.strictEqual(persona.name, name)
        assert.strictEqual(renderPersona(persona), card)
      }
    })
  )

  it.effect(
    "the cast has hands and seats by card, the Chief of Staff first and the Memory Manager last",
    () =>
      Effect.gen(function* () {
        const cast = yield* bundledSpecialists
        assert.deepStrictEqual(
          cast.map((persona) => [persona.name, persona.tools, persona.seat]),
          [
            [chiefName, "none", "planner"],
            ["Researcher", "read-only", "planner"],
            ["Engineer", "workspace", "coder"],
            ["Operator", "commands", "verifier"],
            ["Reviewer", "read-only", "reviewer"],
            [writerName, "none", "planner"],
            [memoryName, "none", "planner"]
          ]
        )
        assert.deepStrictEqual(selectableSpecialists, [
          "Researcher",
          "Engineer",
          "Operator",
          "Reviewer",
          memoryName
        ])
        const writer = cast.find((persona) => persona.name === writerName)
        assert.include(writer?.resultTemplate ?? "", "## Answer\n## Sources")
        assert.include(writer?.mandate ?? "", "result.md")
      })
  )
})
