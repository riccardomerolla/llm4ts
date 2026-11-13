import { assert, describe, it } from "@effect/vitest"
import { JsProvider, createClient } from "@llm4ts/js/Client"

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const same = <A, B>(_proof: Same<A, B>): void => undefined

same<JsProvider, "mock" | "openai" | "anthropic" | "gemini" | "lm-studio" | "ollama" | "mlx-lm">(
  true
)

describe("js providers", () => {
  it("accepts the same provider names, in the same order", () => {
    assert.deepStrictEqual(JsProvider.literals, [
      "mock",
      "openai",
      "anthropic",
      "gemini",
      "lm-studio",
      "ollama",
      "mlx-lm"
    ])
  })

  it("builds a client for every provider and refuses another name", () => {
    for (const provider of JsProvider.literals) {
      assert.isFunction(createClient({ provider, model: "m" }).complete)
    }
    for (const provider of ["gemini-api", "lmstudio", "claude", "nope"]) {
      assert.throws(() => createClient({ provider, model: "m" }), /invalid client configuration/)
    }
  })
})
