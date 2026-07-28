import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import {
  Capabilities,
  ExecGrants,
  Grants,
  allGrants,
  allows,
  allowExec,
  currentGrants,
  intersectGrants,
  noneGrants,
  restricted,
  requireCapabilities,
  unionGrants
} from "@llm4ts/core/Capability"

const gitReadOnly = new Grants({
  ...noneGrants,
  git: "Read",
  reasoning: true
})

describe("Grants algebra", () => {
  it("all allows every capability and none allows none", () => {
    const capabilities = [
      Capabilities.GitRead,
      Capabilities.GitWrite,
      Capabilities.GitPush,
      Capabilities.GhRead,
      Capabilities.GhWrite,
      Capabilities.AdoRead,
      Capabilities.AdoWrite,
      Capabilities.Exec("ls"),
      Capabilities.UseCoder,
      Capabilities.UseReasoning,
      Capabilities.Declassify
    ]

    assert.isTrue(capabilities.every((capability) => allows(allGrants, capability)))
    assert.isTrue(capabilities.every((capability) => !allows(noneGrants, capability)))
  })

  it("orders read, write, and push grants", () => {
    const read = new Grants({ ...noneGrants, git: "Read" })
    const write = new Grants({ ...noneGrants, git: "Write" })
    const push = new Grants({ ...noneGrants, git: "Push" })

    assert.isTrue(allows(read, Capabilities.GitRead))
    assert.isFalse(allows(read, Capabilities.GitWrite))
    assert.isTrue(allows(write, Capabilities.GitRead))
    assert.isTrue(allows(write, Capabilities.GitWrite))
    assert.isFalse(allows(write, Capabilities.GitPush))
    assert.isTrue(allows(push, Capabilities.GitPush))
  })

  it("gates individual commands", () => {
    const lsOnly = new Grants({
      ...noneGrants,
      exec: allowExec(["ls", "cat"])
    })

    assert.isTrue(allows(lsOnly, Capabilities.Exec("ls")))
    assert.isTrue(allows(lsOnly, Capabilities.Exec("cat")))
    assert.isFalse(allows(lsOnly, Capabilities.Exec("rm")))
    assert.isTrue(
      allows(new Grants({ ...noneGrants, exec: ExecGrants.All }), Capabilities.Exec("anything"))
    )
  })

  it("intersects pointwise without widening", () => {
    const first = new Grants({
      ...allGrants,
      git: "Write",
      exec: allowExec(["ls", "cat"]),
      declassify: false
    })
    const second = new Grants({
      ...allGrants,
      git: "Push",
      gh: "Read",
      exec: allowExec(["cat", "rm"])
    })
    const intersection = intersectGrants(first, second)

    assert.strictEqual(intersection.git, "Write")
    assert.strictEqual(intersection.gh, "Read")
    assert.deepStrictEqual(intersection.exec, allowExec(["cat"]))
    assert.isFalse(intersection.declassify)
    assert.deepStrictEqual(intersectGrants(allGrants, first), first)
    assert.deepStrictEqual(intersectGrants(first, noneGrants), noneGrants)
    assert.deepStrictEqual(intersectGrants(first, second), intersectGrants(second, first))
  })

  it("unions pointwise to combine witness powers", () => {
    const first = new Grants({
      ...noneGrants,
      git: "Read",
      exec: allowExec(["ls"]),
      coder: true
    })
    const second = new Grants({
      ...noneGrants,
      git: "Push",
      gh: "Read",
      exec: allowExec(["cat"])
    })
    const union = unionGrants(first, second)

    assert.strictEqual(union.git, "Push")
    assert.strictEqual(union.gh, "Read")
    assert.deepStrictEqual(union.exec, allowExec(["ls", "cat"]))
    assert.isTrue(union.coder)
    assert.isFalse(union.declassify)
    assert.deepStrictEqual(unionGrants(noneGrants, first), first)
    assert.deepStrictEqual(unionGrants(first, allGrants), allGrants)
  })

  it.effect("round-trips grants and value-carrying capabilities", () =>
    Effect.gen(function* () {
      const grants = new Grants({
        ...allGrants,
        git: "Write",
        exec: allowExec(["ls"])
      })
      const capability = Capabilities.Exec("rm -rf")
      const grantsCodec = Schema.toCodecJson(Grants)
      const capabilityCodec = Schema.toCodecJson(Capabilities.Schema)

      const encodedGrants = yield* Schema.encodeEffect(grantsCodec)(grants)
      const decodedGrants = yield* Schema.decodeUnknownEffect(grantsCodec)(encodedGrants)
      const encodedCapability = yield* Schema.encodeEffect(capabilityCodec)(capability)
      const decodedCapability =
        yield* Schema.decodeUnknownEffect(capabilityCodec)(encodedCapability)

      assert.deepStrictEqual(decodedGrants, grants)
      assert.deepStrictEqual(decodedCapability, capability)
    })
  )
})

describe("ambient grants", () => {
  it.effect("defaults to all", () =>
    Effect.gen(function* () {
      const grants = yield* currentGrants
      assert.deepStrictEqual(grants, allGrants)
    })
  )

  it.effect("narrows inside a block and restores afterwards", () =>
    Effect.gen(function* () {
      const inside = yield* restricted(gitReadOnly)(currentGrants)
      const after = yield* currentGrants

      assert.deepStrictEqual(inside, gitReadOnly)
      assert.deepStrictEqual(after, allGrants)
    })
  )

  it.effect("cannot widen through nested restrictions", () =>
    Effect.gen(function* () {
      const inside = yield* restricted(gitReadOnly)(restricted(allGrants)(currentGrants))
      assert.deepStrictEqual(inside, gitReadOnly)
    })
  )

  it.effect("forked fibers inherit narrowed grants without leaking to the parent", () =>
    restricted(gitReadOnly)(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(currentGrants)
        const child = yield* Fiber.join(fiber)
        const parent = yield* currentGrants

        assert.deepStrictEqual(child, gitReadOnly)
        assert.deepStrictEqual(parent, gitReadOnly)
      })
    )
  )

  it.effect("fails before running an effect when a capability is missing", () =>
    Effect.gen(function* () {
      const runs = yield* Ref.make(0)
      const guarded = requireCapabilities([Capabilities.GitPush])(
        Ref.update(runs, (count) => count + 1)
      )
      const error = yield* Effect.flip(restricted(noneGrants)(guarded))
      const count = yield* Ref.get(runs)

      assert.strictEqual(error._tag, "CapabilityDenied")
      assert.match(error.message, /GitPush/)
      assert.strictEqual(count, 0)
    })
  )
})
