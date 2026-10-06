import { describe, expect, it } from "vitest"
import { increment, make, reset } from "./counter.ts"

describe("counter", () => {
  it("starts at zero with nothing else in it", () => {
    expect(make()).toEqual({ count: 0 })
  })

  it("increments", () => {
    expect(increment(make()).count).toBe(1)
  })

  // Planted: the counter-history story's acceptance says to restore this test.
  it.skip("resets to zero", () => {
    expect(reset(increment(make())).count).toBe(0)
  })
})
