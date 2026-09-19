import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { makeMemoryWorkspace } from "@llm4ts/flow/Workspace"
import {
  conventionPassAsk,
  forkPackMarkdown,
  forkedReadme,
  GroundingSelection,
  groundingSelectionAsk,
  maxSelectedFilesPerCategory,
  parseFeedback,
  parseForkAs,
  parseTargetKind,
  passesForTargetKind,
  provenanceMarkdown,
  readGroundingFiles,
  selectionsForCategory,
  targetConventionsReviewer,
  validSelections
} from "../lib/pack-fork.ts"

describe("parseTargetKind", () => {
  it.effect("accepts frontend", () =>
    Effect.gen(function* () {
      const kind = yield* parseTargetKind({ LLM4TS_TARGET_KIND: "frontend" })
      assert.strictEqual(kind, "frontend")
    })
  )

  it.effect("accepts backend, case-insensitively", () =>
    Effect.gen(function* () {
      const kind = yield* parseTargetKind({ LLM4TS_TARGET_KIND: "Backend" })
      assert.strictEqual(kind, "backend")
    })
  )

  it.effect("fails when unset", () =>
    Effect.gen(function* () {
      const outcome = yield* Effect.result(parseTargetKind({}))
      assert.strictEqual(outcome._tag, "Failure")
    })
  )

  it.effect("fails on an unrecognized value", () =>
    Effect.gen(function* () {
      const outcome = yield* Effect.result(parseTargetKind({ LLM4TS_TARGET_KIND: "mobile" }))
      assert.strictEqual(outcome._tag, "Failure")
    })
  )
})

describe("parseForkAs", () => {
  it.effect("accepts a kebab-case name", () =>
    Effect.gen(function* () {
      const name = yield* parseForkAs({ LLM4TS_FORK_AS: "acmecorp-nextjs" })
      assert.strictEqual(name, "acmecorp-nextjs")
    })
  )

  it.effect("fails when unset", () =>
    Effect.gen(function* () {
      const outcome = yield* Effect.result(parseForkAs({}))
      assert.strictEqual(outcome._tag, "Failure")
    })
  )

  it.effect("fails on a name with an uppercase letter", () =>
    Effect.gen(function* () {
      const outcome = yield* Effect.result(parseForkAs({ LLM4TS_FORK_AS: "AcmeCorp" }))
      assert.strictEqual(outcome._tag, "Failure")
    })
  )
})

describe("passesForTargetKind", () => {
  it("returns 4 frontend passes with distinct headings", () => {
    const passes = passesForTargetKind("frontend")
    assert.strictEqual(passes.length, 4)
    assert.strictEqual(new Set(passes.map((pass) => pass.heading)).size, 4)
  })

  it("returns 4 backend passes with distinct headings", () => {
    const passes = passesForTargetKind("backend")
    assert.strictEqual(passes.length, 4)
    assert.strictEqual(new Set(passes.map((pass) => pass.heading)).size, 4)
  })
})

describe("conventionPassAsk", () => {
  it("embeds the pass's heading and instructions", () => {
    const ask = conventionPassAsk({ heading: "Test Heading", instructions: "Do the thing." })
    assert.include(ask, "Test Heading")
    assert.include(ask, "Do the thing.")
  })

  it("embeds grounding content when given", () => {
    const ask = conventionPassAsk(
      { heading: "Test Heading", instructions: "Do the thing." },
      "package.json contents here"
    )
    assert.include(ask, "package.json contents here")
  })

  it("embeds prior findings and feedback when refining", () => {
    const ask = conventionPassAsk(
      { heading: "Test Heading", instructions: "Do the thing." },
      undefined,
      {
        priorConventions: "## Test Heading\n\nOld finding.",
        feedback: "You missed the auth layer."
      }
    )
    assert.include(ask, "Old finding.")
    assert.include(ask, "You missed the auth layer.")
  })
})

describe("groundingSelectionAsk", () => {
  const passes = passesForTargetKind("frontend")

  it("embeds every category heading and the real candidate paths", () => {
    const ask = groundingSelectionAsk(passes, ["package.json", "src/app/page.tsx"])
    for (const pass of passes) {
      assert.include(ask, pass.heading)
    }
    assert.include(ask, "package.json")
    assert.include(ask, "src/app/page.tsx")
  })

  it("embeds prior findings and feedback when refining", () => {
    const ask = groundingSelectionAsk(passes, ["package.json"], {
      priorConventions: "## Tech Stack\n\nOld finding.",
      feedback: "Look at the design-system folder too."
    })
    assert.include(ask, "Old finding.")
    assert.include(ask, "Look at the design-system folder too.")
  })
})

describe("validSelections", () => {
  it("drops a selection whose path isn't in the real candidate list", () => {
    const selection = GroundingSelection.make({
      selections: [
        { category: "Tech Stack", path: "package.json", reason: "real" },
        { category: "Tech Stack", path: "made-up-file.json", reason: "hallucinated" }
      ]
    })
    const kept = validSelections(selection, ["package.json"])
    assert.strictEqual(kept.length, 1)
    assert.strictEqual(kept[0]?.path, "package.json")
  })

  it(`caps each category at ${maxSelectedFilesPerCategory} selections`, () => {
    const candidatePaths = Array.from(
      { length: maxSelectedFilesPerCategory + 3 },
      (_, i) => `f${i}.ts`
    )
    const selection = GroundingSelection.make({
      selections: candidatePaths.map((path) => ({ category: "Naming", path, reason: "r" }))
    })
    const kept = validSelections(selection, candidatePaths)
    assert.strictEqual(kept.length, maxSelectedFilesPerCategory)
  })
})

describe("selectionsForCategory", () => {
  it("returns only the paths for the requested category, in order", () => {
    const selections = [
      { category: "Tech Stack", path: "package.json", reason: "r" },
      { category: "Naming", path: "src/index.ts", reason: "r" },
      { category: "Tech Stack", path: "tsconfig.json", reason: "r" }
    ]
    assert.deepStrictEqual(selectionsForCategory(selections, "Tech Stack"), [
      "package.json",
      "tsconfig.json"
    ])
    assert.deepStrictEqual(selectionsForCategory(selections, "Auth"), [])
  })
})

describe("provenanceMarkdown", () => {
  it("lists every category, with selections or an explicit empty note", () => {
    const selections = [
      { category: "Tech Stack & Dependencies", path: "package.json", reason: "manifest" }
    ]
    const markdown = provenanceMarkdown("frontend", selections)
    assert.include(markdown, "package.json")
    assert.include(markdown, "manifest")
    assert.include(markdown, "No files selected")
  })

  it("includes feedback when given", () => {
    const markdown = provenanceMarkdown("frontend", [], "Look harder at auth.")
    assert.include(markdown, "Look harder at auth.")
  })
})

describe("parseFeedback", () => {
  it("returns the trimmed value when set", () => {
    assert.strictEqual(parseFeedback({ LLM4TS_FEEDBACK: "  do better  " }), "do better")
  })

  it("returns undefined when unset or empty", () => {
    assert.isUndefined(parseFeedback({}))
    assert.isUndefined(parseFeedback({ LLM4TS_FEEDBACK: "   " }))
  })
})

describe("readGroundingFiles", () => {
  it.effect("concatenates only the files that exist", () =>
    Effect.gen(function* () {
      const workspace = yield* makeMemoryWorkspace()
      yield* workspace.write("package.json", '{"name":"demo"}')
      const text = yield* readGroundingFiles(workspace, ["package.json", "pnpm-lock.yaml"])
      assert.include(text, "package.json")
      assert.include(text, '"name":"demo"')
      assert.notInclude(text, "pnpm-lock.yaml")
    })
  )

  it.effect("returns an empty string when nothing exists", () =>
    Effect.gen(function* () {
      const workspace = yield* makeMemoryWorkspace()
      const text = yield* readGroundingFiles(workspace, ["package.json"])
      assert.strictEqual(text, "")
    })
  )
})

describe("forkPackMarkdown", () => {
  it("renames the header and drops the scaffold line", () => {
    const source = [
      "# Pack: j2ee-nextjs-spa",
      "",
      "source: jsp",
      "scaffold: ../../scaffolds/nextjs-spa",
      "sources: .*\\.jsp",
      "",
      "## Gates",
      "",
      "- typecheck: pnpm typecheck"
    ].join("\n")
    const forked = forkPackMarkdown(source, "acmecorp-nextjs")
    assert.strictEqual(forked.split("\n")[0], "# Pack: acmecorp-nextjs")
    assert.notInclude(forked, "scaffold:")
    assert.include(forked, "source: jsp")
    assert.include(forked, "## Gates")
  })
})

describe("forkedReadme", () => {
  it("names the source pack, the fork, the target kind, and the source repo", () => {
    const readme = forkedReadme("j2ee-nextjs-spa", "acmecorp-nextjs", "frontend", "/repos/acmecorp")
    assert.include(readme, "j2ee-nextjs-spa")
    assert.include(readme, "acmecorp-nextjs")
    assert.include(readme, "frontend")
    assert.include(readme, "/repos/acmecorp")
  })
})

describe("targetConventionsReviewer", () => {
  it("references conventions.md", () => {
    assert.include(targetConventionsReviewer, "conventions.md")
  })
})
