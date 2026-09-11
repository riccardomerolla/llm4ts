import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { checkPerimeter, enforcePerimeter, isWithinPerimeter } from "@llm4ts/flow/Perimeter"
import { Story } from "@llm4ts/flow/StoryPlan"

const story = Story.make({
  id: "conto-overview",
  title: "Conto overview",
  description: "",
  dependsOn: [],
  owned: ["src/features/conto/overview", "src/contracts/accounts.ts"],
  sharedReadOnly: ["src/kit", "src/App.tsx"],
  provides: []
})

describe("Perimeter", () => {
  it("passes when every changed path is owned", () => {
    const check = checkPerimeter(
      ["src/features/conto/overview/page.tsx", "src/contracts/accounts.ts"],
      story
    )
    assert.isTrue(isWithinPerimeter(check))
  })

  it("separates shared read-only changes from other strays", () => {
    const check = checkPerimeter(
      ["src/kit/components.tsx", "src/App.tsx", "src/features/bonifico/x.ts"],
      story
    )
    assert.deepStrictEqual(check.sharedReadOnly, ["src/kit/components.tsx", "src/App.tsx"])
    assert.deepStrictEqual(check.outside, ["src/features/bonifico/x.ts"])
  })

  it.effect("enforcePerimeter fails typed naming both classes", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        enforcePerimeter(["src/kit/components.tsx", "README.md"], story)
      )
      assert.strictEqual(error._tag, "PerimeterViolation")
      assert.strictEqual(error.story, "conto-overview")
      assert.include(error.message, "src/kit/components.tsx (shared read-only")
      assert.include(error.message, "README.md (not in the story's owned paths)")
      yield* enforcePerimeter(["src/features/conto/overview/a.ts"], story)
    })
  )
})
