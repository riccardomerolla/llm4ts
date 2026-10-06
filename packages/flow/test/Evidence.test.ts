import { assert, describe, it } from "@effect/vitest"
import { fabricatedStatusIssues, unverifiedClaims } from "@llm4ts/flow/Evidence"

describe("unverifiedClaims", () => {
  it("a claimed command carried by a tool call, whitespace and quoting aside, is verified", () => {
    assert.deepStrictEqual(
      unverifiedClaims(
        ["pnpm test", "`pnpm  typecheck`"],
        ['{"command":"pnpm test -- --run src/a.test.ts"}', "pnpm typecheck"]
      ),
      []
    )
  })

  it("a claimed command no tool call carried is unverified", () => {
    assert.deepStrictEqual(unverifiedClaims(["pnpm test"], ["ls -la", "cat src/a.ts"]), [
      "pnpm test"
    ])
    assert.deepStrictEqual(unverifiedClaims(["pnpm test"], []), ["pnpm test"])
  })

  it("empty claims are ignored and nothing claimed means nothing unverified", () => {
    assert.deepStrictEqual(unverifiedClaims(["", "  "], []), [])
    assert.deepStrictEqual(unverifiedClaims([], []), [])
  })

  it("renders one Warning per unverified command", () => {
    const issues = fabricatedStatusIssues(["pnpm test", "pnpm lint"])
    assert.strictEqual(issues.length, 2)
    assert.strictEqual(issues[0]?.severity, "Warning")
    assert.include(issues[0]?.title ?? "", "fabricated status: claimed `pnpm test`")
  })
})
