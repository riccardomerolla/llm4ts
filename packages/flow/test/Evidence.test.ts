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

  it("a call the transcript cut short carries a longer claim that starts with its head", () => {
    const claim =
      "llm4ts tool validate-account --document fixtures/accounts/acc-002.json --openapi contracts/openapi.json --component Account"
    const recorded = `git status --short && ${claim.slice(0, 80)}…`
    assert.deepStrictEqual(unverifiedClaims([claim], [recorded]), [])
    // Too short a head proves nothing; a head of another command proves nothing.
    assert.deepStrictEqual(unverifiedClaims([claim], ["llm4ts tool…"]), [claim])
    assert.deepStrictEqual(unverifiedClaims([claim], [`pnpm test -- fixtures/accounts/acc-002…`]), [
      claim
    ])
    // Without the ellipsis a shorter recording is not a prefix match.
    assert.deepStrictEqual(unverifiedClaims([claim], [claim.slice(0, 80)]), [claim])
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
