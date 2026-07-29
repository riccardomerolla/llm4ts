import { assert, describe, it } from "@effect/vitest"
import { reviewFingerprint } from "@llm4ts/runner/ReviewFingerprint"

describe("review fingerprint", () => {
  it("length-prefixes parts so shifted boundaries produce distinct digests", () => {
    assert.notStrictEqual(reviewFingerprint("ab", "c"), reviewFingerprint("a", "bc"))
  })
})
