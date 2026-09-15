import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"
import {
  Story,
  StoryPlan,
  dependentsOf,
  makeStoryPlanStore,
  parseStoryPlan,
  pathWithin,
  readyStories,
  renderStoryPlan,
  storyHash,
  storyPlanViolations,
  topologicalWaves,
  validateStoryPlan
} from "@llm4ts/flow/StoryPlan"

const story = (
  id: string,
  owned: ReadonlyArray<string>,
  dependsOn: ReadonlyArray<string> = [],
  extra: Partial<{ sharedReadOnly: ReadonlyArray<string>; provides: ReadonlyArray<string> }> = {}
): Story =>
  Story.make({
    id,
    title: `Story ${id}`,
    description: `Implement ${id}.`,
    dependsOn,
    owned,
    sharedReadOnly: extra.sharedReadOnly ?? ["src/kit"],
    provides: extra.provides ?? []
  })

/** The Conto e Bonifico shape in miniature: two contracts, a kit story, pages, a fan-in. */
const demoPlan = StoryPlan.make({
  epicId: "conto-bonifico",
  epic: "Add Conto and Bonifico.",
  stories: [
    story("accounts-contract", ["src/contracts/accounts.ts"]),
    story("payments-contract", ["src/contracts/payments.ts"]),
    story("iban-field", ["src/kit/iban-field.tsx"], [], {
      sharedReadOnly: ["src/kit/components.tsx"]
    }),
    story("conto-overview", ["src/features/conto/overview"], ["accounts-contract"]),
    story("bonifico-form", ["src/features/bonifico/nuovo"], ["payments-contract", "iban-field"]),
    story("home", ["src/features/home", "src/App.tsx"], ["conto-overview", "bonifico-form"])
  ]
})

describe("StoryPlan", () => {
  it("pathWithin treats prefixes as directories, not string prefixes", () => {
    assert.isTrue(pathWithin("src/features/conto/overview/page.tsx", "src/features/conto/overview"))
    assert.isTrue(pathWithin("src/App.tsx", "./src/App.tsx"))
    assert.isFalse(
      pathWithin("src/features/conto/overview-old/page.tsx", "src/features/conto/overview")
    )
    assert.isFalse(pathWithin("src/kit.ts", "src/kit"))
  })

  it("a valid plan has no violations and yields dependency-ordered waves", () => {
    assert.deepStrictEqual(storyPlanViolations(demoPlan), [])
    assert.deepStrictEqual(topologicalWaves(demoPlan), [
      ["accounts-contract", "payments-contract", "iban-field"],
      ["conto-overview", "bonifico-form"],
      ["home"]
    ])
  })

  it("reports every violation at once: cycle, unknown target, overlap, duplicate, bad id", () => {
    const plan = StoryPlan.make({
      epicId: "bad",
      epic: "bad",
      stories: [
        story("a", ["src/a"], ["b"]),
        story("b", ["src/a/inner"], ["a"]),
        story("c", ["src/c"], ["missing"]),
        story("c", [], []),
        story("Not_Kebab", ["src/n"], [], { sharedReadOnly: ["src/n/part"] })
      ]
    })
    const violations = storyPlanViolations(plan)
    assert.isTrue(violations.some((line) => line.includes("dependency cycle: a -> b -> a")))
    assert.isTrue(violations.some((line) => line.includes("unknown story 'missing'")))
    assert.isTrue(violations.some((line) => line.includes("both own 'src/a' / 'src/a/inner'")))
    assert.isTrue(violations.some((line) => line.includes("duplicate story id 'c'")))
    assert.isTrue(violations.some((line) => line.includes("owns no paths")))
    assert.isTrue(violations.some((line) => line.includes("not kebab-case")))
    assert.isTrue(violations.some((line) => line.includes("shared read-only")))
  })

  it.effect("validateStoryPlan fails typed with the full list", () =>
    Effect.gen(function* () {
      const plan = StoryPlan.make({
        epicId: "bad",
        epic: "bad",
        stories: [story("a", ["src/a"], ["a"]), story("b", ["src/a"])]
      })
      const result = yield* Effect.flip(validateStoryPlan(plan))
      assert.strictEqual(result._tag, "StoryPlanInvalid")
      assert.strictEqual(result.violations.length, 2)
      assert.include(result.message, "depends on itself")
    })
  )

  it("readyStories honours done, running, failed and waiting", () => {
    const none = new Set<string>()
    const initial = readyStories(demoPlan, {
      done: none,
      failed: none,
      waiting: none,
      running: none
    })
    assert.deepStrictEqual(
      initial.map((item) => item.id),
      ["accounts-contract", "payments-contract", "iban-field"]
    )
    const later = readyStories(demoPlan, {
      done: new Set(["accounts-contract", "payments-contract"]),
      failed: new Set(["iban-field"]),
      waiting: none,
      running: new Set(["conto-overview"])
    })
    // bonifico-form waits on the failed iban-field; conto-overview is running.
    assert.deepStrictEqual(
      later.map((item) => item.id),
      []
    )
  })

  it("dependentsOf is transitive and in plan order", () => {
    assert.deepStrictEqual(dependentsOf(demoPlan, "payments-contract"), ["bonifico-form", "home"])
    assert.deepStrictEqual(dependentsOf(demoPlan, "home"), [])
  })

  it("storyHash is stable over content and changes with the entry", () => {
    const first = story("x", ["src/x"], ["y"])
    const same = story("x", ["./src/x/"], ["y"])
    const changed = story("x", ["src/x"], ["z"])
    assert.strictEqual(storyHash(first), storyHash(same))
    assert.notStrictEqual(storyHash(first), storyHash(changed))
  })

  it.effect("render → parse round-trips and the store prefers an existing file", () =>
    Effect.gen(function* () {
      const markdown = yield* renderStoryPlan(demoPlan)
      assert.include(markdown, "# Epic: conto-bonifico")
      assert.include(markdown, "1. accounts-contract, payments-contract, iban-field")
      assert.include(markdown, "```json storyplan")
      const parsed = yield* parseStoryPlan(markdown)
      assert.deepStrictEqual(parsed, demoPlan)

      const memory = yield* makeMemoryPlainFileStore()
      const store = makeStoryPlanStore(memory.store)
      const created = yield* store.recoverOrCreate(".llm4ts/epic.md", Effect.succeed(demoPlan))
      assert.strictEqual(created.epicId, "conto-bonifico")
      const other = StoryPlan.make({ epicId: "other", epic: "other", stories: [] })
      const recovered = yield* store.recoverOrCreate(".llm4ts/epic.md", Effect.succeed(other))
      assert.strictEqual(recovered.epicId, "conto-bonifico")
    })
  )

  it.effect("parse fails typed without a fenced block", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(parseStoryPlan("# nothing here"))
      assert.strictEqual(error._tag, "PlanParse")
    })
  )
})
