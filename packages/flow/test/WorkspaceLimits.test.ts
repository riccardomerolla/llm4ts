import { assert, describe, it } from "@effect/vitest"
import {
  defaultWorkspaceLimits,
  legacySourceWorkspaceLimits,
  workspaceLimitsFromEnv
} from "@llm4ts/flow/Workspace"

describe("legacySourceWorkspaceLimits", () => {
  it("raises only the read cap above the defaults", () => {
    assert.isAbove(legacySourceWorkspaceLimits.maxReadBytes, defaultWorkspaceLimits.maxReadBytes)
    assert.strictEqual(
      legacySourceWorkspaceLimits.maxWriteBytes,
      defaultWorkspaceLimits.maxWriteBytes
    )
    assert.strictEqual(legacySourceWorkspaceLimits.maxResults, defaultWorkspaceLimits.maxResults)
    assert.strictEqual(legacySourceWorkspaceLimits.maxDepth, defaultWorkspaceLimits.maxDepth)
  })
})

describe("workspaceLimitsFromEnv", () => {
  it("overrides the read cap with a positive integer LLM4TS_MAX_READ_BYTES", () => {
    const limits = workspaceLimitsFromEnv(
      { LLM4TS_MAX_READ_BYTES: "16777216" },
      legacySourceWorkspaceLimits
    )
    assert.strictEqual(limits.maxReadBytes, 16_777_216)
    assert.strictEqual(limits.maxWriteBytes, legacySourceWorkspaceLimits.maxWriteBytes)
  })

  it("keeps the defaults for unset, empty, non-numeric, or non-positive values", () => {
    for (const value of [undefined, "", "  ", "lots", "-1", "0", "1.5"]) {
      const limits = workspaceLimitsFromEnv(
        value === undefined ? {} : { LLM4TS_MAX_READ_BYTES: value },
        legacySourceWorkspaceLimits
      )
      assert.strictEqual(limits, legacySourceWorkspaceLimits)
    }
  })
})
