import { assert, describe, it } from "@effect/vitest"
import { defaultOrientationChars, orientationChars, orientationOf } from "@llm4ts/flow/Orientation"

const files = [
  "package.json",
  "pnpm-lock.yaml",
  "CONTRIBUTING.md",
  "src/App.tsx",
  "src/kit/Button.tsx",
  "src/kit/Table.tsx",
  "src/features/accounts/page.tsx",
  "src/features/accounts/page.test.tsx",
  "src/features/accounts/messages.it.json",
  "src/features/accounts/messages.en.json",
  "src/features/transfers/page.tsx",
  "src/features/transfers/page.test.tsx",
  "src/contracts/accounts.ts",
  "src/contracts/accounts.fake.ts",
  "node_modules/left-pad/index.js",
  "dist/bundle.js",
  ".llm4ts/epics/x/plan.md"
]

const packageJson = JSON.stringify({
  name: "portal",
  scripts: { dev: "next dev", test: "vitest run", typecheck: "tsc --noEmit", lint: "eslint ." }
})

describe("orientationOf", () => {
  it("lists folders with their file counts, small folders in full, and skips noise", () => {
    const text = orientationOf({ files, packageJson, appDir: ".", budget: defaultOrientationChars })
    assert.isDefined(text)
    assert.include(text, "## Repository orientation")
    assert.include(text, "src/ (11 files)")
    assert.include(text, "src/features/ (6 files)")
    assert.include(text, "src/kit/ (2 files)")
    // a small folder is listed in full, so the coder never runs `ls` on it
    assert.include(text, "src/kit/Button.tsx")
    assert.include(text, "src/contracts/accounts.fake.ts")
    assert.include(text, "package.json")
    assert.include(text, "CONTRIBUTING.md")
    assert.notInclude(text, "node_modules")
    assert.notInclude(text, "dist/")
    assert.notInclude(text, ".llm4ts")
    assert.notInclude(text, "pnpm-lock.yaml")
  })

  it("names the scripts and where the tests live", () => {
    const text = orientationOf({ files, packageJson, appDir: ".", budget: defaultOrientationChars })
    assert.include(
      text,
      "Scripts (package.json): dev: next dev; test: vitest run; typecheck: tsc --noEmit; lint: eslint ."
    )
    assert.include(
      text,
      "Tests live beside the code in: src/features/accounts (1), src/features/transfers (1)"
    )
  })

  it("says where the app lives when it is a subfolder", () => {
    const nested = files.map((file) => `frontend/${file}`)
    const text = orientationOf({ files: nested, packageJson, appDir: "frontend", budget: 8_000 })
    assert.include(text, "The application lives in frontend/")
    assert.include(text, "frontend/src/ (11 files)")
  })

  it("is undefined with no files or no budget, and never longer than the budget", () => {
    assert.isUndefined(orientationOf({ files: [], budget: 8_000 }))
    assert.isUndefined(orientationOf({ files, budget: 0 }))
    const many = Array.from({ length: 3_000 }, (_, index) => `src/gen/part${index}/file${index}.ts`)
    const text = orientationOf({ files: many, budget: 2_000 })
    assert.isDefined(text)
    assert.isAtMost(text.length, 2_000)
    assert.include(text, "## Repository orientation")
  })

  it("a folder too deep is summarised by its count, not expanded", () => {
    const deep = ["a/b/c/d/e/one.ts", "a/b/c/d/e/two.ts", "a/b/c/d/f/three.ts"]
    const text = orientationOf({ files: deep, budget: 8_000 })
    assert.include(text, "a/ (3 files)")
    assert.include(text, "a/b/c/d/e/one.ts")
  })
})

describe("orientationChars", () => {
  it("reads LLM4TS_ORIENTATION_CHARS and leaves the default otherwise", () => {
    assert.deepStrictEqual(orientationChars({}), {})
    assert.deepStrictEqual(orientationChars({ LLM4TS_ORIENTATION_CHARS: "0" }), {
      orientationChars: 0
    })
    assert.deepStrictEqual(orientationChars({ LLM4TS_ORIENTATION_CHARS: "12000" }), {
      orientationChars: 12_000
    })
    assert.deepStrictEqual(orientationChars({ LLM4TS_ORIENTATION_CHARS: "lots" }), {})
  })
})
