import { assert, describe, it } from "@effect/vitest"
import { apiProviderNames } from "@llm4ts/core/Models"
import { JsProvider, createClient } from "@llm4ts/js/Client"

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const same = <A, B>(_proof: Same<A, B>): void => undefined

same<
  JsProvider,
  | "mock"
  | "openai"
  | "anthropic"
  | "gemini"
  | "gemini-api"
  | "lm-studio"
  | "lmstudio"
  | "ollama"
  | "mlx-lm"
  | "mlxlm"
  | "mlx"
>(true)

describe("js providers", () => {
  it("accepts every name LLM4TS_PROVIDER reads, the offered ones first", () => {
    assert.deepStrictEqual(JsProvider.literals, [
      "mock",
      "openai",
      "anthropic",
      "gemini",
      "lm-studio",
      "ollama",
      "mlx-lm",
      "gemini-api",
      "lmstudio",
      "mlxlm",
      "mlx"
    ])
    assert.sameMembers([...JsProvider.literals], [...apiProviderNames])
  })

  it("builds a client for every provider and refuses another name", () => {
    for (const provider of JsProvider.literals) {
      assert.isFunction(createClient({ provider, model: "m" }).complete)
    }
    for (const provider of ["claude", "gemini-cli", "OpenAI", "nope"]) {
      assert.throws(() => createClient({ provider, model: "m" }), /invalid client configuration/)
    }
  })
})
