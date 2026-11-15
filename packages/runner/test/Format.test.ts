import { describe, expect, it } from "@effect/vitest"
import { clock, dollars, elapsed, formatCount } from "../src/Format.ts"

describe("Format", () => {
  it("writes elapsed time in seconds, minutes, then hours", () => {
    expect(elapsed(0, 42_000)).toBe("42s")
    expect(elapsed(0, 187_000)).toBe("3m07s")
    expect(elapsed(0, 3_599_000)).toBe("59m59s")
    expect(elapsed(0, 3_600_000)).toBe("1h00m")
    expect(elapsed(0, 4_500_000)).toBe("1h15m")
    expect(elapsed(0, 26 * 3_600_000 + 120_000)).toBe("26h02m")
  })

  it("writes clocks, counts and money", () => {
    expect(clock(0, 200_000)).toBe("00:03:20")
    expect(clock(undefined, 200_000)).toBe("00:00:00")
    expect(formatCount(950)).toBe("950")
    expect(formatCount(12_400)).toBe("12.4k")
    expect(formatCount(1_250_000)).toBe("1.3M")
    expect(dollars(0.415)).toBe("~$0.41")
  })
})
