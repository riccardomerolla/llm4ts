import { assert, describe, it } from "@effect/vitest"
import { createClient, Llm4tsError, mockClient } from "@llm4ts/js/Client"

describe("JavaScript client facade", () => {
  it("rejects invalid configuration with the stable facade exception", () => {
    try {
      createClient({ provider: "made-up" })
      assert.fail("expected invalid configuration to throw")
    } catch (error) {
      assert.instanceOf(error, Llm4tsError)
      assert.strictEqual(error instanceof Llm4tsError ? error.category : undefined, "Configuration")
    }
  })

  it("runs the mock provider through Promise-returning methods", async () => {
    const client = mockClient()
    const health = await client.health()
    const completion = await client.complete("hello")

    assert.isTrue(health.available)
    assert.strictEqual(health.authentication, "Valid")
    assert.include(completion.content, "mock response")
    assert.strictEqual(completion.metadata.provider, "mock")
    assert.isAbove(completion.usage?.total ?? 0, 0)
  })
})
