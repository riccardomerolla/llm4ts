import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import {
  checkPerimeter,
  enforcePerimeter,
  isWithinPerimeter,
  perimeterGate,
  strayTasks
} from "@llm4ts/flow/Perimeter"
import { Task } from "@llm4ts/flow/Plan"
import { Story, StoryPlan, pathsNamedIn } from "@llm4ts/flow/StoryPlan"

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

// ---- Ownership-aware checks (rehearsal findings of 2026-09-24) ----------------

const owned = (
  id: string,
  paths: ReadonlyArray<string>,
  dependsOn: ReadonlyArray<string> = [],
  sharedReadOnly: ReadonlyArray<string> = ["src/kit", "src/contracts"]
): Story =>
  Story.make({
    id,
    title: id,
    description: id,
    dependsOn,
    owned: paths,
    sharedReadOnly,
    provides: [`${id} provides`]
  })

const bank = StoryPlan.make({
  epicId: "bank",
  epic: "bank",
  stories: [
    owned(
      "accounts-contract",
      ["src/contracts/accounts.ts", "src/contracts/accounts.fake.ts"],
      [],
      ["src/kit"]
    ),
    owned("conto-overview", ["src/features/conto/overview"], ["accounts-contract"]),
    owned("conto-movimenti", ["src/features/conto/movimenti"], ["accounts-contract"]),
    owned("bonifico-form", ["src/features/bonifico/nuovo"]),
    owned(
      "home",
      ["src/features/home", "src/App.tsx"],
      ["conto-overview", "conto-movimenti", "bonifico-form"]
    )
  ]
})

const storyIn = (id: string): Story => {
  const found = bank.story(id)
  if (found === undefined) {
    throw new Error(id)
  }
  return found
}

describe("Perimeter against the plan", () => {
  it("names repository paths in prose, resolving a bare owned file name", () => {
    assert.deepStrictEqual(
      pathsNamedIn(
        bank,
        "Register contoOverviewFeature in App.tsx and read src/kit/api.ts, en/it."
      ),
      ["src/App.tsx", "src/kit/api.ts"]
    )
    assert.deepStrictEqual(pathsNamedIn(bank, "see https://example.com/src/x.ts"), [])
  })

  it("flags tasks outside the story, marking those another story owns", () => {
    const tasks = [
      Task.make({
        title: "Create messages.ts",
        description: "In src/features/conto/overview/messages.ts"
      }),
      Task.make({ title: "Register contoOverviewFeature in App.tsx", description: "" }),
      Task.make({
        title: "Follow the kit",
        description: "Use src/kit/components.tsx inside src/features/conto"
      }),
      Task.make({ title: "Done already", description: "src/App.tsx", completed: true })
    ]
    const strays = strayTasks(bank, storyIn("conto-overview"), tasks)
    assert.deepStrictEqual(
      strays.map((stray) => [stray.task.title, stray.paths, stray.foreign]),
      [["Register contoOverviewFeature in App.tsx", ["src/App.tsx"], true]]
    )
    const wrongFolder = strayTasks(bank, storyIn("bonifico-form"), [
      Task.make({
        title: "Create src/features/bonifico/route.tsx exporting bonificoNuovoFeature",
        description: ""
      })
    ])
    assert.deepStrictEqual(
      wrongFolder.map((stray) => [stray.paths, stray.foreign]),
      [[["src/features/bonifico/route.tsx"], false]]
    )
  })

  it("turns a violation into a Critical gate issue the coder can act on", () => {
    const clean = perimeterGate(["src/features/conto/overview/a.tsx"], storyIn("conto-overview"))
    assert.isTrue(clean.isClean)
    const red = perimeterGate(["src/App.tsx", "src/kit/theme.css"], storyIn("conto-overview"))
    assert.strictEqual(red.issues[0]?.severity, "Critical")
    assert.include(red.issues[0]?.description ?? "", "src/kit/theme.css (shared read-only")
    assert.include(red.issues[0]?.description ?? "", "src/App.tsx (not in the story's owned paths)")
  })
})
