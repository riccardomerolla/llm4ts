import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { parsePersona, renderPersona } from "@llm4ts/flow/Roundtable"
import {
  bundledPersonaCards,
  bundledPersonas,
  defaultAttendees,
  scribeName
} from "../lib/roundtable-personas.ts"

describe("bundled personas", () => {
  it.effect("every bundled card parses, and renders back to itself", () =>
    Effect.gen(function* () {
      for (const [name, card] of Object.entries(bundledPersonaCards)) {
        const persona = yield* parsePersona(name, card)
        assert.strictEqual(persona.name, name)
        assert.strictEqual(renderPersona(persona), card)
      }
    })
  )

  it.effect("the six attendees speak problem first, then solution, then operability", () =>
    Effect.gen(function* () {
      const personas = yield* bundledPersonas
      const attendees = personas.filter((persona) => persona.name !== scribeName)
      assert.deepStrictEqual(
        attendees.map((persona) => persona.name),
        ["PO", "PM", "Sr SW Eng", "Cloud Architect", "DevOps", "SRE"]
      )
      assert.deepStrictEqual(defaultAttendees, [
        "PO",
        "PM",
        "Sr SW Eng",
        "Cloud Architect",
        "DevOps",
        "SRE"
      ])
      const orders = attendees.map((persona) => persona.order)
      assert.deepStrictEqual(
        orders,
        [...orders].sort((a, b) => a - b)
      )
      assert.strictEqual(new Set(orders).size, orders.length)
    })
  )

  it.effect("the Scribe carries the outline and plan templates and never speaks", () =>
    Effect.gen(function* () {
      const personas = yield* bundledPersonas
      const scribe = personas.find((persona) => persona.name === scribeName)
      assert.ok(scribe !== undefined)
      assert.match(scribe.outlineTemplate ?? "", /## Context/)
      assert.match(scribe.planTemplate ?? "", /## Phases/)
      assert.ok(
        scribe.order > Math.max(...personas.filter((p) => p !== scribe).map((p) => p.order))
      )
    })
  )
})
