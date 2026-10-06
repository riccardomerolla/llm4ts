import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { parseStoryPlan, validateStoryPlan } from "@llm4ts/flow/StoryPlan"

// The light comparison fixture (ADR 0027): the seed script materialises it
// as a standalone git repository with the fixed plan beside it. Filesystem
// and git only: no install, no network.
const examples = join(dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = join(examples, "..")

describe("epic-light fixture", () => {
  it.effect("the fixed plan is a valid story plan with the planted declarations", () =>
    Effect.gen(function* () {
      const text = readFileSync(join(repoRoot, "flows/fixtures/epic-stories/epic-light.md"), "utf8")
      const plan = yield* validateStoryPlan(yield* parseStoryPlan(text))
      assert.deepStrictEqual(
        plan.stories.map((story) => story.id),
        ["format-contract", "greeting-locale", "counter-history"]
      )
      const history = plan.story("counter-history")
      assert.isTrue(history?.testsChange)
      assert.isTrue(history?.owned.includes("src/app.ts"))
      assert.isFalse(plan.story("greeting-locale")?.testsChange)
      assert.isTrue(plan.stories.every((story) => story.acceptance.length >= 3))
    })
  )

  it("seeds a repository with the planted red test, the skipped test, and the plan outside git", () => {
    const dest = mkdtempSync(join(tmpdir(), "llm4ts-epic-light-"))
    try {
      execFileSync("bash", [join(examples, "seed.sh"), "epic", dest], { encoding: "utf8" })
      for (const path of [
        "package.json",
        "pnpm-lock.yaml",
        "tsconfig.json",
        "eslint.config.mjs",
        ".gitignore",
        "CONTRIBUTING.md",
        "README.md",
        "src/app.ts",
        "src/features/greeting/greeting.ts",
        "src/features/greeting/greeting.test.ts",
        "src/features/counter/counter.ts",
        "src/features/counter/counter.test.ts",
        "src/platform/clock.ts",
        "src/platform/clock.test.ts",
        ".llm4ts/epics/epic-light/plan.md"
      ]) {
        assert.isTrue(existsSync(join(dest, path)), `missing ${path}`)
      }
      assert.include(
        readFileSync(join(dest, "src/features/counter/counter.test.ts"), "utf8"),
        "it.skip("
      )
      assert.include(
        readFileSync(join(dest, "src/platform/clock.test.ts"), "utf8"),
        "isLeapYear(1900)).toBe(true)"
      )
      const tracked = execFileSync("git", ["-C", dest, "ls-files"], { encoding: "utf8" })
      assert.notInclude(tracked, ".llm4ts/")
      assert.include(tracked, "src/platform/clock.test.ts")
      const head = execFileSync("git", ["-C", dest, "log", "--format=%s", "-1"], {
        encoding: "utf8"
      })
      assert.strictEqual(head.trim(), "Seed epic starter")
    } finally {
      rmSync(dest, { recursive: true, force: true })
    }
  })
})
