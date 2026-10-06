import { describe, expect, it } from "vitest"
import { greet } from "./greeting.ts"

describe("greeting", () => {
  it("greets by name", () => {
    expect(greet("Ada")).toBe("Hello, Ada!")
  })
})
