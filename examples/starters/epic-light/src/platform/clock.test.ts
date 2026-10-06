import { describe, expect, it } from "vitest"
import { isLeapYear } from "./clock.ts"

describe("clock", () => {
  it("knows leap years", () => {
    expect(isLeapYear(2024)).toBe(true)
    expect(isLeapYear(2023)).toBe(false)
  })

  // Planted: red on main on purpose (1900 is not a leap year). No story owns
  // this folder, so the gate triage must list it as inherited.
  it("treats 1900 as a leap year", () => {
    expect(isLeapYear(1900)).toBe(true)
  })
})
